#!/usr/bin/env python3
"""Register snailog's built-in rooms with ChanServ (idempotent).

Rooms: #lobby (default room) and #snailog-presence (hidden, used by the app for
friends' status messages). See ROOMS below.

What it does, connecting straight to solanum (not through soju):
  1. identifies as the owner account (LOBBY_OWNER, default "snailog"), registering
     it with NickServ first if it doesn't exist yet;
  2. joins each room and, if it isn't registered yet, registers it with
     ChanServ (needs channel op, so the room must be empty or we must be op);
  3. applies per room: GUARD ON (ChanServ sits in the room, so it never disappears),
     KEEPTOPIC + TOPICLOCK ON, its MLOCK, and its topic.

The owner password comes from server/.env (LOBBY_OWNER_PASSWORD). If it's
missing, a random one is generated and appended to .env.

If a room already has people in it (e.g. a soju user joined first and got
op), pass --op-via-soju <soju-user>: that user's bouncer connection is asked
(sojuctl "network quote") to op the owner, so nobody has to leave the room.

Usage: python3 scripts/setup-rooms.py [--op-via-soju USER] [host] [port]
"""

import os
import secrets
import socket
import ssl
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(os.path.dirname(HERE), ".env")

# (channel, topic, mode lock)
ROOMS = [
    # Default room everyone lands in.
    ("#lobby", "Welcome to snailog! Say hi and hang out here :)", "+nt"),
    # Hidden (+s) room every snailog app joins: carries friends' status messages
    # (STATUS lines, kept in soju history) and live Online/Offline via
    # away-notify. Not shown in the app's room list.
    ("#snailog-presence", "snailog status updates (used by the app, not for chatting)", "+nts"),
]


def load_env():
    env = {}
    if os.path.exists(ENV_PATH):
        for line in open(ENV_PATH):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


def ensure_password(env):
    if env.get("LOBBY_OWNER_PASSWORD"):
        return env["LOBBY_OWNER_PASSWORD"]
    pw = secrets.token_urlsafe(18)
    with open(ENV_PATH, "a") as fh:
        fh.write("\n# NickServ account that owns snailog's rooms (scripts/setup-rooms.py)\n")
        fh.write(f"LOBBY_OWNER={env.get('LOBBY_OWNER', 'snailog')}\n")
        fh.write(f"LOBBY_OWNER_PASSWORD={pw}\n")
    print(f"[setup] generated LOBBY_OWNER_PASSWORD and saved it to {ENV_PATH}")
    return pw


ENV = load_env()
OWNER = ENV.get("LOBBY_OWNER", "snailog")
PASSWORD = ensure_password(ENV)
argv = sys.argv[1:]
OP_VIA_SOJU = None
if "--op-via-soju" in argv:
    i = argv.index("--op-via-soju")
    OP_VIA_SOJU = argv[i + 1]
    del argv[i:i + 2]
HOST = argv[0] if len(argv) > 0 else "localhost"
PORT = int(argv[1]) if len(argv) > 1 else int(ENV.get("SOLANUM_TLS_PORT", "6697"))
NETWORK = ENV.get("SOJU_NETWORK", "solanum")


def redact(text):
    """Never print the owner password (NickServ echoes it back on REGISTER)."""
    return text.replace(PASSWORD, "****")

# solanum enforces need_ssl on client connections: wrap the socket in TLS,
# trusting the local CA that issued the server cert (server/pki/ca.pem).
CA = os.path.join(os.path.dirname(HERE), "pki", "ca.pem")
ctx = ssl.create_default_context(cafile=CA)
sock = socket.create_connection((HOST, PORT), timeout=15)
sock = ctx.wrap_socket(sock, server_hostname="solanum")
f = sock.makefile("rw", encoding="utf-8", errors="replace", newline="\r\n")


SERVICE_DELAY = 1.5   # Atheme ignores clients that send services commands too fast


def send(line):
    if line.startswith(("PRIVMSG ChanServ", "PRIVMSG NickServ")):
        time.sleep(SERVICE_DELAY)
    print(">>", redact(line))
    f.write(line + "\r\n")
    f.flush()


def read_until(pred, timeout=15):
    """Read lines (answering PING) until pred(line) is truthy; return that line."""
    end = time.time() + timeout
    while time.time() < end:
        line = f.readline().rstrip("\r\n")
        if not line:
            raise SystemExit("[FAIL] connection closed")
        if line.startswith("PING"):
            send("PONG" + line[4:])
            continue
        print("<<", redact(line))
        if pred(line):
            return line
    raise SystemExit("[FAIL] timed out waiting for server reply")


def service_reply(service, needles, timeout=10):
    """Wait for a NOTICE from `service` containing any of `needles` (case-insensitive)."""
    return read_until(lambda l: l.startswith(f":{service}!") and f" NOTICE {OWNER} :" in l
                      and any(n in l.lower() for n in needles), timeout)


# --- connect -----------------------------------------------------------------
send(f"NICK {OWNER}")
send(f"USER {OWNER} 0 * :snailog lobby owner")
welcome = read_until(lambda l: " 001 " in l or " 433 " in l)
if " 433 " in welcome:
    raise SystemExit(f"[FAIL] nick {OWNER} is in use; disconnect that client and retry")

# --- owner account -----------------------------------------------------------
send(f"PRIVMSG NickServ :IDENTIFY {OWNER} {PASSWORD}")
r = service_reply("NickServ", ["you are now identified", "you are now logged in", "not a registered", "invalid password",
                               "not registered"])
if "not a registered" in r.lower() or "not registered" in r.lower():
    send(f"PRIVMSG NickServ :REGISTER {PASSWORD} lobby@snailog.invalid")
    r = service_reply("NickServ", ["registered", "invalid", "too many"])
    if "is now registered" not in r.lower():
        raise SystemExit(f"[FAIL] NickServ REGISTER: {r}")
    print(f"[setup] registered NickServ account {OWNER}")
elif "invalid password" in r.lower():
    raise SystemExit(f"[FAIL] {OWNER} exists with a different password than LOBBY_OWNER_PASSWORD")
else:
    print(f"[setup] identified as {OWNER}")

# --- rooms -------------------------------------------------------------------
def setup_room(channel, topic, mlock):
    send(f"JOIN {channel}")
    current_topic, names = None, ""
    while True:  # JOIN burst: optional 332 (topic), 353 (names), then 366 (end)
        l = read_until(lambda l: any(f" {n} " in l for n in ("332", "353", "366")))
        if " 332 " in l:
            current_topic = l.split(" :", 1)[1]
        elif " 353 " in l:
            names += " " + l.split(" :", 1)[1]
        else:
            break
    send(f"PRIVMSG ChanServ :INFO {channel}")
    info = service_reply("ChanServ", ["end of info", "is not registered"])

    if "is not registered" in info.lower():
        if f"@{OWNER}" not in names.split():
            if not OP_VIA_SOJU:
                raise SystemExit(f"[FAIL] {channel} has people in it and {OWNER} isn't op; "
                                 "ChanServ REGISTER needs op. Re-run with --op-via-soju <op'd soju user>.")
            cmd = ["docker", "exec", "soju", "/sojuctl", "-config", "/soju-config",
                   "user", "run", OP_VIA_SOJU, "network", "quote", NETWORK,
                   f"MODE {channel} +o {OWNER}"]
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            print(f"[setup] asked {OP_VIA_SOJU} (via soju) to op {OWNER}: {(p.stdout + p.stderr).strip()}")
            read_until(lambda l: f" MODE {channel} +o {OWNER}" in l)
        send(f"PRIVMSG ChanServ :REGISTER {channel}")
        r = service_reply("ChanServ", ["registered", "must be", "you need"])
        if "is now registered" not in r.lower():
            raise SystemExit(f"[FAIL] ChanServ REGISTER: {r}")
        print(f"[setup] registered {channel}")
    else:
        print(f"[setup] {channel} already registered")

    for opt in ("GUARD ON", "KEEPTOPIC ON", "TOPICLOCK ON", f"MLOCK {mlock}"):
        send(f"PRIVMSG ChanServ :SET {channel} {opt}")
        service_reply("ChanServ", ["set", "already", "locked", "enabled", "mlock"])
    if current_topic != topic:  # ChanServ stays silent if the topic is unchanged
        send(f"PRIVMSG ChanServ :TOPIC {channel} {topic}")
        read_until(lambda l: f" TOPIC {channel} " in l
                   or (l.startswith(":ChanServ!") and f" NOTICE {OWNER} :" in l))
    else:
        print(f"[setup] {channel} topic already set")
    send(f"PART {channel} :setup done")
    print(f"[OK] {channel}: registered, guarded by ChanServ, MLOCK {mlock}, topic: {topic}")


for channel, topic, mlock in ROOMS:
    setup_room(channel, topic, mlock)

send("QUIT :bye")
time.sleep(0.5)
