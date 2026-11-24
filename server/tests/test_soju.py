#!/usr/bin/env python3
"""End-to-end test for the Soju bouncer.

Connects to Soju on port 16667, authenticates via SASL PLAIN as the
'pointilis' bouncer user, binds to the 'solanum' network
(username 'pointilis/solanum'), joins a channel and queries NickServ.

Prereq: run `docker exec soju /sojuctl -config /soju-config user create
-username pointilis -password change-me -admin` once.

Usage: python3 tests/test_soju.py [host] [port]
"""

import base64
import socket
import sys
import time

HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 16667

BOUNCER_USER = "pointilis"
BOUNCER_PASS = "change-me"
NETWORK = "solanum"
CHANNEL = "#testchan"

s = socket.create_connection((HOST, PORT), timeout=10)
s.settimeout(15)
f = s.makefile("rw", encoding="utf-8", newline="\r\n")


def send(line):
    print(">>", line)
    f.write(line + "\r\n")
    f.flush()


def read_until(pred, timeout=15):
    """Read lines until pred(line) is true. Returns True on match."""
    end = time.time() + timeout
    while time.time() < end:
        line = f.readline()
        if not line:
            break
        print("<<", line.rstrip())
        if pred(line):
            return True
    return False


def require(pred, what, timeout=15):
    if not read_until(pred, timeout):
        raise TimeoutError(f"timed out waiting for: {what}")
    print(f"[PASS] {what}")


# --- bouncer authentication (SASL PLAIN) ---
send("CAP LS 302")
send(f"NICK {BOUNCER_USER}/{NETWORK}")
send(f"USER {BOUNCER_USER}/{NETWORK} 0 * :Soju Client")
require(lambda l: " CAP * LS " in l, "CAP LS")

send("CAP REQ :sasl")
require(lambda l: " CAP * ACK sasl" in l, "CAP ACK sasl")

send("AUTHENTICATE PLAIN")
require(lambda l: "AUTHENTICATE +" in l, "AUTHENTICATE challenge")

token = base64.b64encode(f"\0{BOUNCER_USER}\0{BOUNCER_PASS}".encode()).decode()
send(f"AUTHENTICATE {token}")
require(lambda l: " 903 " in l, "SASL auth success (903)")

send("CAP END")
require(lambda l: " 001 " in l, "bouncer welcome (001)")

# --- network-bound session ---
send(f"JOIN {CHANNEL}")
require(lambda l: "#testchan" in l and ("JOIN" in l or "topic" in l.lower()),
        "joined channel via upstream", timeout=10)

send(f"PRIVMSG {CHANNEL} :hello via soju")
time.sleep(2)
require(lambda l: "PING" in l or "hello via soju" in l, "message sent", timeout=6)

send("PRIVMSG NickServ :INFO")
time.sleep(2)
require(lambda l: "NickServ" in l, "NickServ reachable through bouncer", timeout=8)

s.close()
print("ALL TESTS PASSED")
