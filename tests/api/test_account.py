#!/usr/bin/env python3
"""Account service: create account, recovery email, password reset by email,
login limits. Creates one throw-away account (zzt…) and deletes it again.

Needs the docker stack (api, soju, mailpit). Uses one of the 5
account creations allowed per IP per hour."""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from a09f import MAILPIT, Check, http  # noqa: E402

check = Check("account service: register / email / reset")
user = f"zzt{int(time.time()) % 100000}"
pw, pw2 = "first-pass-1", "second-pass-2"


def sojuctl(*args):
    return subprocess.run(["docker", "exec", "soju", "/sojuctl", "-config", "/soju-config", *args],
                          capture_output=True, text=True)


def delete_user(u):
    out = sojuctl("user", "delete", u).stdout + sojuctl("user", "delete", u).stderr
    m = re.search(r'user delete \S+ ([0-9A-Za-z]+)"', out)
    if m:
        sojuctl("user", "delete", u, m.group(1))


def latest_code(to):
    with urllib.request.urlopen(f"{MAILPIT}/api/v1/messages") as r:
        msgs = json.load(r)["messages"]
    for m in msgs:
        if m["To"][0]["Address"] == to:
            with urllib.request.urlopen(f"{MAILPIT}/api/v1/message/{m['ID']}") as r:
                return re.search(r"code is: (\d{6})", json.load(r)["Text"]).group(1)
    return None


try:
    r = http("POST", "/register", {"username": user, "password": pw, "email": "not-an-email"})
    check("bad email rejected", not r.get("ok"), r)
    r = http("POST", "/register", {"username": user, "password": "has space 1", "email": f"{user}@example.com"})
    check("password with spaces rejected", not r.get("ok"), r)
    r = http("POST", "/register", {"username": user, "password": pw, "email": f"{user}@example.com"})
    check("account created", r.get("ok"), r)
    if r.get("error", "").startswith("Too many"):
        print("  (rate limit: restart the register container to reset it)")
    r = http("POST", "/register", {"username": user, "password": pw, "email": f"{user}@example.com"})
    check("same ID refused", not r.get("ok") and "taken" in r.get("error", ""), r)

    r = http("POST", "/email", {"username": user, "password": "wrong-pass"})
    check("/email: wrong password refused", not r.get("ok"), r)
    r = http("POST", "/email", {"username": user, "password": pw})
    check("/email: reads the recovery email", r.get("email") == f"{user}@example.com", r)

    r = http("POST", "/reset/request", {"username": "nosuchuserzz"})
    check("reset: unknown ID", not r.get("ok"), r)
    r = http("POST", "/reset/request", {"username": user})
    check("reset: code emailed (masked address)", r.get("ok") and "***@" in r.get("email", ""), r)
    r = http("POST", "/reset/request", {"username": user})
    check("reset: cooldown between codes", not r.get("ok"), r)
    time.sleep(1)
    code = latest_code(f"{user}@example.com")
    check("reset: code arrived in Mailpit", bool(code))
    r = http("POST", "/reset/confirm", {"username": user, "code": "000000" if code != "000000" else "111111", "password": pw2})
    check("reset: wrong code refused", not r.get("ok"), r)
    r = http("POST", "/reset/confirm", {"username": user, "code": code, "password": pw2})
    check("reset: right code accepted", r.get("ok"), r)
    r = http("POST", "/reset/confirm", {"username": user, "code": code, "password": pw2})
    check("reset: code works only once", not r.get("ok"), r)
    check("old password no longer works", not http("POST", "/session", {"username": user, "password": pw}).get("ok"))
    check("new password works", http("POST", "/session", {"username": user, "password": pw2}).get("ok"))

    ok = all(http("POST", "/session", {"username": user, "password": pw2}).get("ok") for _ in range(12))
    check("many good sign-ins are never rate limited", ok)
finally:
    delete_user(user)

check.done()
