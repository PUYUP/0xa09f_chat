#!/usr/bin/env python3
"""End-to-end test for the Solanum IRCd + Atheme services.

Connects directly to Solanum on port 6667 (or 6697 with --tls), negotiates
echo-message, registers a fresh nickname via NickServ (Atheme), identifies,
joins a channel and sends a message.

Uses a unique nick per run so the test is self-contained and repeatable
even after services.db is reset.

Usage: python3 tests/test_solanum.py [--tls] [host] [port]
"""

import random
import socket
import ssl
import string
import sys
import time

args = [a for a in sys.argv[1:] if not a.startswith("--")]
USE_TLS = "--tls" in sys.argv

HOST = args[0] if len(args) > 0 else "127.0.0.1"
PORT = int(args[1]) if len(args) > 1 else (6697 if USE_TLS else 6667)

NICK = "t" + "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
PASSWORD = "testpass123"
EMAIL = f"{NICK}@test.local"
CHANNEL = "#testchan"

raw = socket.create_connection((HOST, PORT), timeout=10)
if USE_TLS:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # self-signed dev cert
    s = ctx.wrap_socket(raw, server_hostname=HOST)
else:
    s = raw
s.settimeout(15)
f = s.makefile("rw", encoding="utf-8", newline="\r\n")


def send(line):
    print(">>", line)
    f.write(line + "\r\n")
    f.flush()


def read_until(pred, timeout=15):
    """Read lines until pred(line) is true. Returns matched lines."""
    end = time.time() + timeout
    buf = []
    while time.time() < end:
        line = f.readline()
        if not line:
            break
        buf.append(line.rstrip())
        print("<<", line.rstrip())
        if pred(line):
            return buf
    raise TimeoutError(f"timed out waiting for predicate")


def require(pred, what, timeout=15):
    read_until(pred, timeout)
    print(f"[PASS] {what}")


# --- connect + caps ---
send("CAP LS 302")
send(f"NICK {NICK}")
send(f"USER {NICK} 0 * :Sol Test")
require(lambda l: " CAP * LS " in l or " CAP " in l and " LS " in l, "CAP LS")

send("CAP REQ :echo-message")
require(lambda l: " ACK " in l and "echo-message" in l, "CAP ACK echo-message")

send("CAP END")
require(lambda l: " 001 " in l, "welcome (001)")
require(lambda l: " 372 " in l, "MOTD delivered (372)")

# --- Atheme services ---
send(f"PRIVMSG NickServ :REGISTER {PASSWORD} {EMAIL}")
require(
    lambda l: "NickServ" in l
    and any(k in l.lower() for k in ("registered", "success", "invalid", "email")),
    "NickServ REGISTER responded",
    timeout=10,
)

send(f"PRIVMSG NickServ :IDENTIFY {NICK} {PASSWORD}")
require(lambda l: " 900 " in l or "identified" in l.lower()
        or "already logged in" in l.lower(),
        "NickServ IDENTIFY", timeout=10)

# --- channel ---
send(f"JOIN {CHANNEL}")
require(lambda l: "JOIN" in l and CHANNEL in l, "joined channel", timeout=10)

send(f"PRIVMSG {CHANNEL} :hello world")
require(lambda l: "hello world" in l and "PRIVMSG" in l,
        "message echoed back", timeout=8)

s.close()
print("ALL TESTS PASSED")
