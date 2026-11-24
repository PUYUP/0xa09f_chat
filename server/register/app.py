#!/usr/bin/env python3
"""a09f self-service account registration.

Tiny HTTP service that lets a person create their own soju bouncer account
from the desktop app's "Create account" screen. For each new account it:

  1. creates a soju user (non-admin) with its own nick, and
  2. adds the upstream IRC network for that user, using the same nick,

so every person shows up on IRC under their own name instead of a shared one.

It talks to soju only through `sojuctl` over soju's admin unix socket
(mounted from the soju-db volume). Stdlib only, no dependencies.

API
  GET  /health                       -> 200 {"ok": true}
  POST /register {"username","password"}
       201 {"ok": true, "username": ...}
       400 / 409 / 429 / 500 {"ok": false, "error": "<human readable>"}
"""

import json
import os
import re
import subprocess
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SOJUCTL = ["sojuctl", "-config", os.environ.get("SOJU_CONFIG", "/soju-config")]
UPSTREAM_ADDR = os.environ.get("UPSTREAM_ADDR", "irc+insecure://solanum:6667")
NETWORK_NAME = os.environ.get("NETWORK_NAME", "solanum")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "8080"))

# Per client IP, sliding one-hour window.
MAX_ATTEMPTS_PER_HOUR = int(os.environ.get("MAX_ATTEMPTS_PER_HOUR", "30"))
MAX_CREATES_PER_HOUR = int(os.environ.get("MAX_CREATES_PER_HOUR", "5"))

# Usernames double as IRC nicks: must start with a letter, IRC-safe chars only.
USERNAME_RE = re.compile(r"^[a-z][a-z0-9_-]{2,15}$")
RESERVED = {
    "admin", "root", "administrator", "operator", "oper", "system", "server",
    "soju", "solanum", "atheme", "a09f", "help", "support", "staff",
}
MIN_PASSWORD, MAX_PASSWORD = 8, 128

_lock = threading.Lock()              # serialize sojuctl mutations
_attempts = defaultdict(deque)        # ip -> timestamps
_creates = defaultdict(deque)


class Fail(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def sojuctl(*argv):
    p = subprocess.run([*SOJUCTL, *argv], capture_output=True, text=True, timeout=30)
    return p.returncode, (p.stdout + p.stderr).strip()


def over_limit(bucket, ip, limit):
    q, now = bucket[ip], time.monotonic()
    while q and now - q[0] > 3600:
        q.popleft()
    return len(q) >= limit


def validate(username, password):
    if not isinstance(username, str) or not isinstance(password, str):
        raise Fail(400, "Please enter an ID and a password.")
    if not USERNAME_RE.match(username):
        raise Fail(400, "ID must be 3–16 characters: lowercase letters, numbers, - or _, "
                        "and start with a letter.")
    if username in RESERVED or username.endswith("serv"):
        raise Fail(409, "That ID isn't available. Please choose another.")
    if not (MIN_PASSWORD <= len(password) <= MAX_PASSWORD):
        raise Fail(400, f"Password must be at least {MIN_PASSWORD} characters.")
    # sojuctl speaks a line-based protocol to soju; never let control
    # characters (CR/LF/NUL...) reach it.
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in password):
        raise Fail(400, "Password contains characters that aren't allowed.")
    # The desktop app reuses this password for the account's NickServ (Atheme)
    # registration, and Atheme passwords can't contain spaces.
    if any(c.isspace() for c in password):
        raise Fail(400, "Password can't contain spaces.")


def create_account(username, password):
    with _lock:
        rc, _ = sojuctl("user", "status", username)
        if rc == 0:
            raise Fail(409, "That ID is already taken. Please choose another.")

        rc, out = sojuctl("user", "create", "-username", username, "-password", password,
                          "-nick", username, "-realname", username)
        if rc != 0:
            print(f"[register] user create {username} failed: {out}", flush=True)
            raise Fail(500, "Couldn't create the account right now. Please try again later.")

        rc, out = sojuctl("user", "run", username, "network", "create",
                          "-addr", UPSTREAM_ADDR, "-name", NETWORK_NAME,
                          "-nick", username, "-realname", username,
                          # Away while no device is connected: this is how the
                          # desktop app tells "Offline" from "Online".
                          "-auto-away", "true")
        if rc != 0:
            print(f"[register] network create for {username} failed: {out}", flush=True)
            _rollback(username)
            raise Fail(500, "Couldn't create the account right now. Please try again later.")

    print(f"[register] created {username}", flush=True)


def _rollback(username):
    """Best-effort delete of a half-created user (delete needs a confirm token)."""
    # First call only returns: To confirm user deletion, send "user delete <u> <token>"
    rc, out = sojuctl("user", "delete", username)
    token = re.search(r'user delete \S+ ([0-9A-Za-z]+)"', out or "")
    if token:
        rc, out = sojuctl("user", "delete", username, token.group(1))
    print(f"[register] rollback {username}: rc={rc} {out}", flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "a09f-register"

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _cors(self):
        # Called from the desktop app's webview (tauri:// / http://tauri.localhost).
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/register":
            self._json(404, {"ok": False, "error": "not found"})
            return
        ip = self.client_address[0]
        try:
            if over_limit(_attempts, ip, MAX_ATTEMPTS_PER_HOUR) or \
               over_limit(_creates, ip, MAX_CREATES_PER_HOUR):
                raise Fail(429, "Too many tries. Please wait a while and try again.")
            _attempts[ip].append(time.monotonic())

            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 4096:
                raise Fail(400, "Please enter an ID and a password.")
            try:
                body = json.loads(self.rfile.read(length))
            except ValueError:
                raise Fail(400, "Please enter an ID and a password.")
            if not isinstance(body, dict):
                raise Fail(400, "Please enter an ID and a password.")

            username = str(body.get("username", "")).strip().lower()
            password = body.get("password", "")
            validate(username, password)
            create_account(username, password)
            _creates[ip].append(time.monotonic())
            self._json(201, {"ok": True, "username": username})
        except Fail as f:
            self._json(f.status, {"ok": False, "error": f.message})
        except Exception as e:  # never leak internals to the client
            print(f"[register] error: {e!r}", flush=True)
            self._json(500, {"ok": False, "error": "Something went wrong. Please try again later."})

    def log_message(self, fmt, *args):
        # Default logging prints the request line only (no bodies/passwords).
        print(f"[register] {self.client_address[0]} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"[register] listening on :{LISTEN_PORT}, network {NETWORK_NAME} -> {UPSTREAM_ADDR}",
          flush=True)
    ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler).serve_forever()
