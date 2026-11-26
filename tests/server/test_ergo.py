#!/usr/bin/env python3
"""Ergo, the IRC server, configured the way a09f needs it.

- plaintext (:16667) and TLS (:16697) listeners answer
- the IRCv3 capabilities the app asks for are offered
- SASL is required: a connection without an account is refused
- a wrong password is refused (904); a demo account signs in (903 + 001)
- accounts are always-on and auto-away; nick = account
- registering accounts over IRC is off (only the account service creates them)

Usage: python3 tests/server/test_ergo.py   (A09F_IRC_HOST/PORT, A09F_IRC_TLS_PORT)
"""

import base64
import os
import socket
import ssl
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from a09f import DEMO_PASSWORD, IRC, Check, Irc  # noqa: E402

TLS_PORT = int(os.environ.get("A09F_IRC_TLS_PORT", "16697"))
WANTED = ["sasl", "server-time", "message-tags", "batch", "echo-message", "away-notify",
          "draft/chathistory", "draft/read-marker", "draft/pre-away"]
check = Check("Ergo server")


def raw_session(lines, secs=3.0, tls=False):
    s = socket.create_connection((IRC[0], TLS_PORT if tls else IRC[1]), timeout=10)
    if tls:
        ctx = ssl.create_default_context()
        ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE   # self-signed dev cert
        s = ctx.wrap_socket(s, server_hostname=IRC[0])
    for l in lines:
        s.sendall((l + "\r\n").encode())
    s.settimeout(0.3)
    data, end = b"", time.time() + secs
    while time.time() < end:
        try:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
        except (socket.timeout, ssl.SSLError):
            pass
    s.close()
    return data.decode(errors="replace")


def sasl_lines(user, password):
    return ["CAP LS 302", "CAP REQ :sasl", f"NICK {user}", f"USER {user} 0 * :t", "AUTHENTICATE PLAIN",
            "AUTHENTICATE " + base64.b64encode(f"{user}\0{user}\0{password}".encode()).decode(), "CAP END"]


out = raw_session(["CAP LS 302"], 2)
offered = {c.split("=")[0] for l in out.splitlines() if " CAP " in l for c in l.split(" :", 1)[-1].split()}
missing = [c for c in WANTED if c not in offered]
check("app's capabilities are offered", not missing, missing)

out = raw_session(["NICK anon1234", "USER anon 0 * :anon"], 3)
check("no account → refused (SASL required)", "001" not in out and ("ERROR" in out or "904" in out or "SASL" in out), out[-200:])

out = raw_session(sasl_lines("alice", "definitely-wrong"), 3)
check("wrong password → 904", " 904 " in out, out[-200:])

out = raw_session(sasl_lines("alice", DEMO_PASSWORD), 3, tls=True)
check("TLS listener: demo account signs in (903, 001)", " 903 " in out and " 001 " in out, out[-200:])

a = Irc("alice")
check("plaintext listener: demo account signs in", bool(a.welcome))
bare = (a.welcome or "").split(" ", 1)[1] if (a.welcome or "").startswith("@") else (a.welcome or "")
nick = bare.split()[2] if bare else ""
check("nick = account", nick == "alice", a.welcome)
reply = " ".join(a.service("NickServ", "GET always-on", 3) + a.service("NickServ", "GET auto-away", 3)).lower()
check("account is always-on with auto-away",
      "your client is always-on" in reply and "auto-away is enabled" in reply, reply)
reply = " ".join(a.service("NickServ", "REGISTER pass-12345", 3)).lower()
check("accounts can't be registered over IRC", "disabled" in reply or "not" in reply or "already" in reply, reply)
a.close()

check.done()
