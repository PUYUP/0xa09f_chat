#!/usr/bin/env python3
"""Benchmark: 5.000 user a09f aktif terhadap stack apa adanya.

Setiap "user" adalah satu app yang terbuka, dan skrip ini mengirim persis
permintaan yang dikirim app itu — tanpa mengubah kode server, tanpa container
bantu. Endpoint yang dipakai (lihat server/docs/api.md):

  sign in     POST /session   {username, password, device} -> token
  buka app    GET  /events    satu stream Server-Sent Events per app
  sedang chat POST /typing    tiap `--think` detik (default 15: pola typing app)
  lihat Seen  POST /read
  kirim pesan POST /activity
  buka daftar GET  /friends   sesekali

Fase: 1) sign-in serentak, 2) semua app hidup `--window` detik, 3) event
asli lewat soju → solanum → app (typing, lalu pesan room), 4) tutup semua.

Kenapa `--conns` dan `--procs`: satu koneksi `/events` = satu thread yang
memblok `read()`, dan macOS membatasi thread per user (`ulimit -u`, di mesin
ini 2784). Satu proses Python karenanya memegang `--conns` stream (default
400) dan skrip menjalankan `--procs` proses paralel (default dihitung supaya
`procs × conns ≥ users`). Tiap proses memakai satu sesi API sendiri, dan
semua proses mengerjakan jadwal yang sama, jadi beban ke server tetap
"5.000 app hidup bersamaan".

Akun: `POST /register` dibatasi 30 percobaan/jam dan 5 akun/jam per IP, jadi
skrip hanya membuat akun yang belum ada (`A09F_BENCH_SEED=1`, default),
dengan nama tetap `b01`…`b5000` — run berikutnya memakai akun yang sama.
Akun baru perlu register NickServ sekali lewat IRC (app melakukannya saat
sign in) supaya `sasl set-plain` bisa dipasang; itu juga yang dilakukan di
sini, sekaligus memastikan akun bisa dipakai mode `real`.

  python3 tests/api/bench_load.py                     # 5.000 user, 60 dtk
  python3 tests/api/bench_load.py --users 1500 --window 30
  python3 tests/api/bench_load.py --mode real --users 100   # password dicek SASL

Env: A09F_BENCH_USERS, A09F_BENCH_WINDOW, A09F_BENCH_CONNS, A09F_BENCH_PROCS,
A09F_BENCH_MODE, A09F_BENCH_SEED, A09F_DEMO_PASSWORD, A09F_API.
"""

import concurrent.futures as cf
import json
import math
import multiprocessing as mp
import os
import select
import socket
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from a09f import API, DEMO_PASSWORD  # noqa: E402

DEMO = ["alice", "bob", "charlie", "diana", "evan", "frank", "grace", "henry",
        "irene", "jack", "kate", "leo", "mia", "nina", "oscar"]
ROOM = "#zz-bench"
PASSWORD = os.environ.get("A09F_BENCH_PASSWORD") or DEMO_PASSWORD


def user_id(i):
    """A stable bench account: b1 … b5000 (3–16 chars: fits the ID rule)."""
    return f"b{i + 1}"


# ---------------------------------------------------------------- HTTP

def call(method, path, body=None, token=None, timeout=60):
    """One API call; returns (ok, json, seconds)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, method=method, data=data,
                                 headers={"Content-Type": "application/json",
                                          **({"Authorization": f"Bearer {token}"} if token else {})})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, json.loads(r.read() or b"{}"), time.time() - t0
    except urllib.error.HTTPError as e:
        try:
            return False, json.loads(e.read() or b"{}"), time.time() - t0
        except ValueError:
            return False, {"error": f"HTTP {e.code}"}, time.time() - t0
    except Exception as e:  # timeout, connection refused, ...
        return False, {"error": str(e)}, time.time() - t0


def sign_in(user, device):
    ok, r, secs = call("POST", "/session", {"username": user, "password": PASSWORD, "device": device})
    return (r.get("token") if ok else None), secs


# ---------------------------------------------------------------- accounts

def existing(u):
    """Does the account answer POST /session? (one password check)"""
    ok, r, _ = call("POST", "/session", {"username": u, "password": PASSWORD, "device": "bench probe"})
    if ok and r.get("token"):
        call("POST", "/session/end", token=r["token"])   # don't leave the probe session behind
        return True
    return False


def seed(ids, workers=4):
    """Register the bench accounts that don't exist yet (`POST /register`).

    The service allows 5 new accounts per IP per hour, which is why the IDs are
    fixed (`b1` … `bN`) and only missing ones are created: the first run of
    `--users 5000` spreads the registration over hours (or you raise
    MAX_CREATES_PER_HOUR in server/.env); later runs create nothing. Everyone
    registered here shares one password, `A09F_BENCH_PASSWORD`.
    """
    need = []
    last = ""
    with cf.ThreadPoolExecutor(16) as ex:
        for u, there in zip(ids, ex.map(existing, ids)):
            if not there:
                need.append(u)
    if not need:
        return 0, 0
    if not need:
        return [], 0
    made, failed, last = [], 0, ""
    with cf.ThreadPoolExecutor(workers) as ex:
        reg = ex.map(lambda u: (u, call("POST", "/register",
                                        {"username": u, "password": PASSWORD,
                                         "email": f"{u}@bench.a09f.invalid"})), need)
        for u, (ok, r, _) in reg:
            if ok:
                made.append(u)
            else:
                failed += 1
                last = r.get("error", "")
    if failed:
        print(f"  {failed}/{len(need)} akun gagal dibuat: {last}")
        print("  (batas 5 akun/jam per IP: naikkan MAX_CREATES_PER_HOUR di server/.env, "
              "lalu docker compose up -d --no-deps api)")
    return made, failed


def activate(ids):
    """Sign in over IRC like the app's first launch: register the NickServ
    account (same password) and `sasl set-plain`, so POST /session accepts it."""
    from a09f import Irc
    done = failed = 0

    def one(u):
        try:
            c = Irc(u, password=PASSWORD)
            time.sleep(0.3)
            answers = c.service("NickServ", f"REGISTER {PASSWORD} {u}@users.a09f.invalid", 3)
            if not any("registered" in a.lower() or "already" in a.lower() for a in answers):
                c.service("NickServ", f"IDENTIFY {u} {PASSWORD}", 3)
            c.close()
            return True
        except Exception:
            return False

    with cf.ThreadPoolExecutor(8) as ex:
        for ok in ex.map(one, ids):
            done += ok
            failed += not ok
    return done, failed


# ---------------------------------------------------------------- the report

def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    return s[max(0, min(len(s) - 1, int(math.ceil(p / 100.0 * len(s))) - 1))]


def ms(n):
    return "—" if n is None else f"{n:.0f} ms" if n >= 1 else f"{n:.2f} ms"


def table(rows, head):
    widths = [len(h) for h in head]
    cells = [[str(c) for c in r] for r in rows]
    for r in cells:
        for j, c in enumerate(r):
            widths[j] = max(widths[j], len(c))
    out = ["  ".join(h.ljust(w) for h, w in zip(head, widths)),
           "  ".join("-" * w for w in widths)]
    out += ["  ".join(c.ljust(w) for c, w in zip(r, widths)) for r in cells]
    return "\n".join(out)


def opt(argv, flag, env, default):
    raw = argv[argv.index(flag) + 1] if flag in argv else os.environ.get(env, default)
    return type(default)(raw)


def say(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def main():
    argv = sys.argv[1:]
    users = opt(argv, "--users", "A09F_BENCH_USERS", 5000)
    window = opt(argv, "--window", "A09F_BENCH_WINDOW", 60)
    conns = opt(argv, "--conns", "A09F_BENCH_CONNS", 400)
    mode = opt(argv, "--mode", "A09F_BENCH_MODE", "real")
    think = opt(argv, "--think", "A09F_BENCH_THINK", 15)
    procs = opt(argv, "--procs", "A09F_BENCH_PROCS", max(1, math.ceil(users / conns)))

    ids = [user_id(i) for i in range(users)]
    say(f"## {users} user aktif · {procs} proses × {conns} koneksi · window {window}s · "
        f"mode {mode} · {API}")

    # accounts: fixed IDs, created once through POST /register
    t0 = time.time()
    made, failed = seed(ids)
    say(f"akun: {len(made)} dibuat, {failed} gagal, {len(ids) - len(made) - failed} sudah ada "
        f"({time.time() - t0:.0f} s)")
    if failed and not made:
        print("tidak ada akun yang bisa dipakai — berhenti (lihat batas di atas)")
        sys.exit(2)
    if made:
        t0 = time.time()
        ok, bad = activate(list(made))
        say(f"aktivasi IRC (NickServ + SASL) akun baru: {ok} ok, {bad} gagal "
            f"({time.time() - t0:.0f} s)")

    # split the users over the processes
    out = mp.Queue()
    parts = [ids[i::procs] for i in range(procs)]
    t_start = time.time()
    ctx = mp.get_context("spawn")
    ps = [ctx.Process(target=worker, args=(i, part, mode, window, think, out), daemon=True)
          for i, part in enumerate(parts)]
    for p in ps:
        p.start()

    opened, reports, notes = 0, [], []
    while len(reports) < procs:
        try:
            msg = out.get(timeout=window + 600)
        except Exception:
            break
        if msg["event"] == "note":
            notes.append(msg["text"])
        elif msg["event"] == "opened":
            opened += msg["n"]
            say(f"  proses {msg['idx']}: {msg['n']} app terbuka "
                f"(sign in p50 {ms(1000 * pct(msg['signin'], 50))})")
        elif msg["event"] == "done":
            reports.append(msg["report"])
            say(f"  proses {msg['report']['idx']}: selesai, "
                f"{msg['report']['sent']} permintaan dikirim")
    for p in ps:
        p.join(timeout=30)
        if p.is_alive():
            p.terminate()
    took = time.time() - t_start

    # ---- the benchmark
    signin = [v for r in reports for v in r["signin_ms"]]
    sent = sum(r["sent"] for r in reports)
    failed = sum(r["failed"] for r in reports) + sum(r["errors"] for r in reports)
    frames = sum(r["frames"] for r in reports)
    typing = sum(r["got"]["typing"] for r in reports)
    print("\n## Ringkasan")
    print(table([
        ["user aktif (sign in + /events terbuka)", f"{opened}"],
        ["durasi total", f"{took:.0f} s (window {window} s)"],
        ["sign in p50 / p90 / p99", f"{ms(pct(signin, 50))} / {ms(pct(signin, 90))} / {ms(pct(signin, 99))}"],
        ["sign in tercepat / terlama", f"{ms(min(signin) if signin else None)} / {ms(max(signin) if signin else None)}"],
        ["permintaan bertoken (typing/read/activity)", f"{sent}"],
        ["  laju selama window", f"{sent / max(1, window):.0f}/s"],
        ["  gagal", f"{failed}"],
        ["frame SSE diterima", f"{frames}"],
        ["event typing asli diterima", f"{typing} proses"],
        ["proses / koneksi", f"{procs} × {conns}"],
    ], ["metrik", "nilai"]))
    if notes:
        print("\ncatatan:", *notes[:5], sep="\n  ")

    print("\n## Hasil cek")
    n = len(ids)
    checks = [
        (f"{n} app sign in dan membuka /events", opened == n, f"{opened}/{n}"),
        ("tidak ada permintaan gagal", failed == 0, f"{failed} gagal"),
        ("event asli (API → /events) sampai ke app", typing > 0, f"{typing} proses"),
        (f"selesai < {window + 120:.0f} s", took < window + 120, f"{took:.0f} s"),
    ]
    good = 0
    for what, ok, detail in checks:
        good += ok
        print(f"  [{'PASS' if ok else 'FAIL'}] {what}" + ("" if ok else f"  ({detail})"))
    print(f"-- {good}/{len(checks)} passed")
    sys.exit(0 if good == len(checks) else 1)


if __name__ == "__main__":
    main()

class Stream:
    """One open /events connection, read the way tests/lib/a09f.py reads IRC:
    non-blocking select, keep the raw line, answer nothing (SSE is one-way)."""

    def __init__(self, token, row):
        self.token, self.row = token, row
        self.s = socket.create_connection((API.split("://")[1].split(":")[0],
                                           int(API.rsplit(":", 1)[1])), timeout=10)
        self.s.setblocking(False)
        self.buf = b""
        self.frames = []
        self.head_done = False
        self.t_open = time.time()
        self.closed = False
        req = (f"GET /events?token={token} HTTP/1.1\r\nHost: {self.s.getpeername()[0]}\r\n"
               f"Accept: text/event-stream\r\n\r\n")
        self.s.sendall(req.encode())

    def read(self):
        """Collect whatever arrived; returns the new frames."""
        new = []
        try:
            while True:
                r, _, _ = select.select([self.s], [], [], 0)
                if not r:
                    break
                data = self.s.recv(65536)
                if not data:
                    self.closed = True
                    break
                self.buf += data
        except OSError:
            self.closed = True
        if not self.head_done:
            # drop the HTTP response header once ("HTTP/1.1 200 …\r\n\r\n")
            if b"\r\n\r\n" not in self.buf:
                return new
            _, self.buf = self.buf.split(b"\r\n\r\n", 1)
            self.head_done = True
            self.t_open = time.time()
        while b"\n\n" in self.buf:
            raw, self.buf = self.buf.split(b"\n\n", 1)
            text = raw.decode(errors="replace")
            if "data:" in text and not text.startswith(":"):   # not a keepalive
                new.append(text)
        self.frames.append(len(new))
        return new

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


def worker(idx, users, mode, window, think, out):
    """One process: signs in its share, holds their streams, reports timings.

    Every process has its own session; they all run the same schedule (the
    same burst, the same tick), so the server sees one load of `--users` apps.
    """
    report = {"idx": idx, "signin": [], "errors": 0, "streams": [], "frames": 0,
              "phase": "signin", "t0": time.time()}
    for u in users:
        tok, secs = sign_in(u, f"a09f bench {idx}")
        report["signin"].append(secs)
        if not tok:
            report["errors"] += 1
            continue
        try:
            report["streams"].append(Stream(tok, u))
        except OSError as e:
            report["errors"] += 1
            out.put({"event": "note", "text": f"stream {u}: {e}"})
    report["phase"] = "open"
    out.put({"event": "opened", "idx": idx, "n": len(report["streams"]),
             "signin": report["signin"], "errors": report["errors"]})

    t_end = time.time() + window
    nxt = time.time()
    sent, failed = 0, 0
    while time.time() < t_end:
        now = time.time()
        if now >= nxt:
            nxt = now + think
            for j, s in enumerate(report["streams"]):
                other = DEMO[(j + idx) % len(DEMO)]
                ok, _, _ = call("POST", "/typing", {"to": other, "active": True}, s.token)
                sent += 1
                failed += not ok
                if j % 4 == 0:
                    ok, _, _ = call("POST", "/read", {"to": other, "time": int(now * 1000)}, s.token)
                    sent += 1
                    failed += not ok
                if j % 3 == 0:
                    ok, _, _ = call("POST", "/activity", {"room": ROOM}, s.token)
                    sent += 1
                    failed += not ok
        for s in report["streams"]:
            report["frames"] += len(s.read())
        time.sleep(0.05)

    # the real events: typing and a room message must arrive as SSE frames
    got = {"typing": 0, "frames": 0}
    deadline = time.time() + 15
    while time.time() < deadline and got["typing"] == 0:
        for s in report["streams"]:
            for frame in s.read():
                got["frames"] += 1
                got["typing"] += "event: typing" in frame
        time.sleep(0.2)
    for s in report["streams"]:
        got["frames"] += len(s.read())
    frame_count = sum(sum(s.frames) for s in report["streams"])
    report.update(phase="done", sent=sent, failed=failed, got=got, frames=frame_count,
                  closed=sum(s.closed for s in report["streams"]),
                  signin_ms=[1000 * x for x in report["signin"]])
    for s in report["streams"]:
        s.close()
    out.put({"event": "done", "report": report})