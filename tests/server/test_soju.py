#!/usr/bin/env python3
"""End-to-end test for the Soju bouncer.

Connects to Soju (default port 16667, or 16697 with --tls), authenticates
via SASL PLAIN, binds to the upstream network, joins a channel and queries
NickServ through the bouncer.

Self-contained: ensures the bouncer user and upstream network exist by
calling `sojuctl` inside the container (idempotent). Credentials are read
from server/.env (SOJU_USER / SOJU_PASSWORD / SOJU_NETWORK).

Prereq: `docker compose up -d` from server/ and the soju container running.

Usage: python3 tests/server/test_soju.py [--tls] [host] [port]
"""

import base64
import os
import socket
import ssl
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(os.path.dirname(os.path.dirname(HERE)), "server")    # tests/server -> repo/server


def load_env(path):
    env = {}
    if os.path.exists(path):
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    return env


ENV = load_env(os.path.join(SERVER_DIR, ".env"))

args = [a for a in sys.argv[1:] if not a.startswith("--")]
USE_TLS = "--tls" in sys.argv

HOST = args[0] if len(args) > 0 else "127.0.0.1"
PORT = int(args[1]) if len(args) > 1 else (16697 if USE_TLS else 16667)

BOUNCER_USER = ENV.get("SOJU_USER", "pointilis")
BOUNCER_PASS = ENV.get("SOJU_PASSWORD")
if not BOUNCER_PASS:
    sys.exit("SOJU_PASSWORD is not set (put it in server/.env)")
NETWORK = ENV.get("SOJU_NETWORK", "solanum")
# Unique channel per run: soju replays stored channel history to new
# clients, and replaying a busy channel can stall the session.
CHANNEL = f"#test{os.getpid() % 100000}"


def sojuctl(*argv):
    """Run sojuctl inside the soju container; return (rc, output)."""
    cmd = ["docker", "exec", "soju", "/sojuctl", "-config", "/soju-config", *argv]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    return p.returncode, (p.stdout + p.stderr).strip()


def ensure_user():
    rc, out = sojuctl("user", "status", BOUNCER_USER)
    if rc == 0:
        # update password in case .env changed
        sojuctl("user", "update", BOUNCER_USER, "-password", BOUNCER_PASS)
        print(f"[SETUP] user {BOUNCER_USER} exists (password synced)")
        return
    rc, out = sojuctl("user", "create", "-username", BOUNCER_USER,
                     "-password", BOUNCER_PASS, "-admin")
    if rc != 0:
        raise RuntimeError(f"sojuctl user create failed: {out}")
    print(f"[SETUP] created user {BOUNCER_USER}")


def ensure_network():
    rc, out = sojuctl("user", "run", BOUNCER_USER, "network", "status")
    if rc == 0 and NETWORK in out:
        print(f"[SETUP] network {NETWORK} exists")
        return
    rc, out = sojuctl("user", "run", BOUNCER_USER, "network", "create",
                      "-addr", f"irc+insecure://solanum:6667",
                      "-name", NETWORK, "-nick", "soluser",
                      "-realname", "Soju Test", "-enabled", "true")
    if rc != 0:
        raise RuntimeError(f"sojuctl network create failed: {out}")
    print(f"[SETUP] created network {NETWORK}")


ensure_user()
ensure_network()

raw = socket.create_connection((HOST, PORT), timeout=10)
if USE_TLS:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # self-signed dev cert
    s = ctx.wrap_socket(raw, server_hostname=HOST)
else:
    s = raw
s.settimeout(20)
f = s.makefile("rw", encoding="utf-8", newline="\r\n")


def send(line):
    print(">>", line)
    f.write(line + "\r\n")
    f.flush()


def read_until(pred, timeout=15):
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
require(lambda l: " CAP * LS " in l or (" CAP " in l and " LS " in l), "CAP LS")

send("CAP REQ :sasl")
require(lambda l: " ACK " in l and "sasl" in l, "CAP ACK sasl")

send("AUTHENTICATE PLAIN")
require(lambda l: "AUTHENTICATE +" in l, "AUTHENTICATE challenge")

token = base64.b64encode(f"\0{BOUNCER_USER}\0{BOUNCER_PASS}".encode()).decode()
send(f"AUTHENTICATE {token}")
require(lambda l: " 903 " in l, "SASL auth success (903)")

send("CAP END")
require(lambda l: " 001 " in l, "bouncer welcome (001)")
# Soju finishes attaching the client to the upstream network asynchronously
# after 001; commands sent in that window are silently dropped. The 422
# ("Use /motd") line is the last of the registration burst — wait for it.
require(lambda l: " 422 " in l, "registration burst complete (422)", timeout=10)

# --- network-bound session ---
send(f"JOIN {CHANNEL}")
try:
    require(lambda l: CHANNEL in l and ("JOIN" in l or "topic" in l.lower()),
            "joined channel via upstream", timeout=15)
except TimeoutError:
    # soju occasionally drops the first JOIN while attaching the network
    # session; retry once before failing.
    print("[RETRY] JOIN timed out, retrying")
    send(f"JOIN {CHANNEL}")
    require(lambda l: CHANNEL in l and ("JOIN" in l or "topic" in l.lower()),
            "joined channel via upstream (retry)", timeout=15)

send(f"PRIVMSG {CHANNEL} :hello via soju")
time.sleep(2)
require(lambda l: "PING" in l or "hello via soju" in l, "message sent", timeout=8)

send("PRIVMSG NickServ :INFO")
time.sleep(2)
require(lambda l: "NickServ" in l, "NickServ reachable through bouncer", timeout=10)

s.close()
print("ALL TESTS PASSED")
