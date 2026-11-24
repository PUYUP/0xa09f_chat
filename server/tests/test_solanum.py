#!/usr/bin/env python3
"""End-to-end test for the Solanum IRCd + Atheme services.

Connects directly to Solanum on port 6667, registers a nickname via
NickServ (Atheme), identifies, joins a channel and sends a message.

Usage: python3 tests/test_solanum.py [host] [port]
"""

import socket
import sys
import time

HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 6667

NICK = "soltest2"
PASSWORD = "soltest2pass"
EMAIL = "soltest2@test.local"
CHANNEL = "#testchan"

s = socket.create_connection((HOST, PORT), timeout=10)
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
    raise TimeoutError(f"timed out waiting for {pred}")


send("CAP LS 302")
send(f"NICK {NICK}")
send(f"USER {NICK} 0 * :Sol Test")
read_until(lambda l: " CAP * LS " in l)
send("CAP REQ :echo-message")
read_until(lambda l: " ACK " in l and "echo-message" in l)
send("CAP END")
read_until(lambda l: " 001 " in l)
print("[PASS] connected and welcomed (001)")

send(f"PRIVMSG NickServ :REGISTER {PASSWORD} {EMAIL}")
read_until(
    lambda l: "NickServ" in l
    and any(k in l.lower() for k in ("registered", "success", "invalid", "email")),
    timeout=10,
)
print("[PASS] NickServ REGISTER responded")

send(f"PRIVMSG NickServ :IDENTIFY {NICK} {PASSWORD}")
time.sleep(2)

send(f"JOIN {CHANNEL}")
read_until(lambda l: "JOIN" in l and CHANNEL in l, timeout=10)
print("[PASS] joined channel")

send(f"PRIVMSG {CHANNEL} :hello world")
time.sleep(2)
read_until(lambda l: "hello world" in l and "PRIVMSG" in l, timeout=6)
print("[PASS] message echoed back")

s.close()
print("ALL TESTS PASSED")
