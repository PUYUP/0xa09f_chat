"""Shared helpers for the a09f test suites (stdlib only).

- Irc:   a real IRC client that signs in to soju with SASL, like the app does
- Api:   the account service (server/api) with a session token
- sse:   collect Server-Sent Events from /events in a background thread
- Check: PASS/FAIL bookkeeping; exit code 1 when anything failed

Demo accounts (alice, bob, …) use the password DEMO_PASSWORD; override with
A09F_DEMO_PASSWORD. Hosts/ports default to the local docker stack.
"""

import base64
import json
import os
import re
import select
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

SOJU = (os.environ.get("A09F_SOJU_HOST", "127.0.0.1"), int(os.environ.get("A09F_SOJU_PORT", "16667")))
SOLANUM = (os.environ.get("A09F_SOLANUM_HOST", "127.0.0.1"), int(os.environ.get("A09F_SOLANUM_PORT", "6667")))
API = os.environ.get("A09F_API", "http://127.0.0.1:16680")
MAILPIT = os.environ.get("A09F_MAILPIT", "http://127.0.0.1:16825")
DEMO_PASSWORD = os.environ.get("A09F_DEMO_PASSWORD", "demo-1234")
NETWORK = "solanum"


# ---------------------------------------------------------------- IRC

class Irc:
    """IRC client through soju. `client` makes the soju client id unique so
    soju doesn't replay an old backlog for it (that confuses tests)."""

    def __init__(self, user, password=DEMO_PASSWORD, caps=("server-time",), client=None, addr=SOJU):
        self.user = user
        self.buf = b""
        self.lines = []
        cid = client or f"t{int(time.time() * 1000) % 10**9}"
        self.s = socket.create_connection(addr, timeout=10)
        self.send("CAP LS 302")
        self.send("CAP REQ :" + " ".join(("sasl",) + tuple(caps)))
        self.send(f"NICK {user}")
        self.send(f"USER {user} 0 * :{user}")
        self.send("AUTHENTICATE PLAIN")
        time.sleep(0.4)
        ident = f"{user}@{cid}/{NETWORK}"
        self.send("AUTHENTICATE " + base64.b64encode(f"{ident}\0{ident}\0{password}".encode()).decode())
        self.send("CAP END")
        self.welcome = self.wait(r" 001 ", 10)

    def send(self, line):
        self.s.sendall((line + "\r\n").encode())

    def read(self, secs=1.0):
        """Read for `secs`, answer PINGs, return the new lines."""
        end, new = time.time() + secs, []
        while time.time() < end:
            r, _, _ = select.select([self.s], [], [], 0.1)
            if not r:
                continue
            data = self.s.recv(65536)
            if not data:
                break
            self.buf += data
            while b"\r\n" in self.buf:
                raw, self.buf = self.buf.split(b"\r\n", 1)
                line = raw.decode(errors="replace")
                if line.startswith("PING "):
                    self.send("PONG " + line[5:])
                    continue
                new.append(line)
        self.lines += new
        return new

    def wait(self, pattern, secs=10.0):
        """First new line matching `pattern` within `secs` (or None)."""
        rx = re.compile(pattern)
        end = time.time() + secs
        while time.time() < end:
            for line in self.read(0.2):
                if rx.search(line):
                    return line
        return None

    def ask(self, line, pattern, secs=6.0):
        self.send(line)
        return self.wait(pattern, secs)

    def service(self, service, command, secs=3.0):
        """Message a service (ChanServ/NickServ), return its NOTICE texts."""
        self.send(f"PRIVMSG {service} :{command}")
        end, out = time.time() + secs, []
        while time.time() < end:
            for line in self.read(0.2):
                bare = line.split(" ", 1)[1] if line.startswith("@") else line     # drop @tags
                if bare.startswith(f":{service}!") and " NOTICE " in bare:
                    out.append(bare.split(" :", 1)[-1].replace("\x02", ""))
        return out

    def close(self):
        try:
            self.send("QUIT")
            self.s.close()
        except OSError:
            pass


def drop_room(user, room):
    """Unregister a test room (ChanServ DROP needs a confirmation key)."""
    c = Irc(user)
    try:
        reply = " ".join(c.service("ChanServ", f"DROP {room}", 3))
        m = re.search(r"DROP \S+ ([0-9a-f:]+)", reply)
        if m:
            time.sleep(1.5)
            c.service("ChanServ", f"DROP {room} {m.group(1)}", 3)
        c.send(f"PART {room}")
        c.read(0.5)
    finally:
        c.close()


# ---------------------------------------------------------------- account service

class ApiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body}")
        self.status, self.body = status, body


def http(method, path, body=None, token=None, raw=False):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json",
                                          **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read()
            return (r.status, data) if raw else json.loads(data)
    except urllib.error.HTTPError as e:
        data = e.read()
        if raw:
            return e.code, data
        try:
            return json.loads(data)
        except ValueError:
            raise ApiError(e.code, data[:200])


class Api:
    """The account service as one user."""

    def __init__(self, user, password=DEMO_PASSWORD, device="a09f tests"):
        self.user = user
        r = http("POST", "/session", {"username": user, "password": password, "device": device})
        if not r.get("ok"):
            raise ApiError(403, r)
        self.token, self.sid, self.admin = r["token"], r["sid"], r.get("admin")

    def get(self, path):
        return http("GET", path, token=self.token)

    def post(self, path, body=None):
        return http("POST", path, body or {}, token=self.token)


def sse(token, sink, stop):
    """Append (event, data) from /events to `sink` until `stop` is set."""
    def run():
        try:
            with urllib.request.urlopen(f"{API}/events?token={token}", timeout=300) as r:
                ev = None
                for raw in r:
                    if stop.is_set():
                        return
                    line = raw.decode().strip()
                    if line.startswith("event:"):
                        ev = line[6:].strip()
                    elif line.startswith("data:"):
                        sink.append((ev, json.loads(line[5:])))
        except Exception:
            pass
    t = threading.Thread(target=run, daemon=True)
    t.start()
    time.sleep(0.8)
    return t


def wait_until(fn, secs=10.0, step=0.2):
    end = time.time() + secs
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return None


def fnv(text):
    """The app's msgHash (FNV-1a over UTF-16 code units, base36)."""
    h = 0x811c9dc5
    for ch in text:
        cp = ord(ch)
        units = [cp] if cp < 0x10000 else [0xD800 + ((cp - 0x10000) >> 10), 0xDC00 + ((cp - 0x10000) & 0x3FF)]
        for u in units:
            h ^= u
            h = (h * 0x01000193) & 0xFFFFFFFF
    digits, out = "0123456789abcdefghijklmnopqrstuvwxyz", ""
    while True:
        out = digits[h % 36] + out
        h //= 36
        if not h:
            return out


def server_ms(line):
    """The @time tag of an IRC line, in ms."""
    m = re.match(r"@time=([^; ]+)", line)
    if not m:
        return None
    ts = m.group(1)
    import calendar
    return calendar.timegm(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")) * 1000 + int(ts[20:23])


# How to run SQL on the account service's database (test clean-up only).
PSQL = os.environ.get("A09F_PSQL", "docker exec -i postgres psql -U soju -d a09f").split()


def sql(statement):
    """Run SQL on the account service's Postgres database (test clean-up only)."""
    import subprocess
    subprocess.run(PSQL + ["-v", "ON_ERROR_STOP=1", "-q", "-c", statement], check=True, capture_output=True)


# ---------------------------------------------------------------- reporting

class Check:
    def __init__(self, name):
        self.name, self.failed, self.count = name, 0, 0
        print(f"== {name}")

    def __call__(self, what, ok, detail=""):
        self.count += 1
        if not ok:
            self.failed += 1
        print(f"  [{'PASS' if ok else 'FAIL'}] {what}" + (f"  ({detail})" if detail and not ok else ""))
        return ok

    def skip(self, what, why):
        print(f"  [SKIP] {what}  ({why})")

    def done(self):
        print(f"-- {self.name}: {self.count - self.failed}/{self.count} passed")
        sys.exit(1 if self.failed else 0)
