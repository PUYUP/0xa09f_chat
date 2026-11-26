#!/usr/bin/env python3
"""a09f self-service account registration.

Tiny HTTP service that lets a person create their own soju bouncer account
from the desktop app's "Create account" screen. For each new account it:

  1. creates a soju user (non-admin) with its own nick, and
  2. adds the upstream IRC network for that user, using the same nick,

so every person shows up on IRC under their own name instead of a shared one.

It also keeps each account's recovery email (SQLite, DATA_DIR) and runs the
"Forgot password?" flow: a 6-digit code is emailed (SMTP_*), and on a valid
code the password is changed everywhere it lives: soju, NickServ (sent
through the user's own identified upstream connection) and soju's SASL login.

It talks to soju only through `sojuctl` over soju's admin unix socket
(mounted from the soju-db volume). Stdlib only, no dependencies.

API (errors: 4xx/5xx {"ok": false, "error": "<human readable>"})
  GET  /health
  POST /register        {"username","password","email"}   -> 201
  POST /reset/request   {"username"}                      -> {"ok", "email": masked}
  POST /reset/confirm   {"username","code","password"}    -> {"ok"}
  POST /email           {"username","password"[,"email"]} -> {"ok", "email"}
       Read (no "email") or set the recovery email; the password is checked
       with a real SASL login to soju.

  Social (see social.py), bearer token from POST /session:
  POST /session         {"username","password"}           -> {"ok", "token"}
  GET  /friends                                           -> {"friends","incoming","outgoing"}
  POST /friends/request {"to","group","msg"}              -> {"ok", "result": requested|friends}
  POST /friends/respond {"from","accept","group"}
  POST /friends/remove  {"nick"}
  POST /friends/move    {"nick","group"}
  POST /friends/rename-group {"from","to"}
  POST /typing          {"to","active"}
  POST /read            {"to","time"}          "Seen" receipt for a private chat
  POST /profile/updated                        tell friends (and my devices) to reload my profile
  POST /session/revoke-others                  after a password change: sign out my other devices
  POST /redact          {"target","time","hash"}   delete one of my messages for everyone
  GET  /redactions?since=<unix>
  POST /announce        {"text"}               admins only (ADMIN_USERS)
  GET  /announcements?after=<id>
  GET  /stats                                  {"online": people with a09f open}
  GET  /msgmeta?conv=   reactions + edits (+ pins for a room) of one conversation
  POST /react {"sender","target","time","hash","emoji","on"}
  POST /edit  {"target","time","hash","text"}         (my own messages)
  POST /pin   {"room","sender","time","hash","text","on"}
  POST /poll/create {"room","question","options"}  -> {"id"};  GET /poll?id=;  POST /poll/vote {"id","option"}
  GET  /lastseen?users=a,b
  POST /remind {"text","minutes"};  GET /reminders;  GET /reminders/due
  POST /namecolor {"color"|null};  GET /namecolors?users=a,b
  POST /expire {"target","time","hash","after"}   my message disappears `after` s after it was sent
  POST /save {"sender","target","time","hash","conv","text","on"};  GET /saved
  POST /activity {"room"};  GET /trending          messages per room today
  POST /imv {"with","theme"};  GET /imv?with=     shared theme of a private chat
  GET  /prefs  /  POST /prefs {"ignore":[ids],"friendsOnly":bool}
  GET  /users/search?q= -> {"users": [ids]} (substring match on IDs)
  GET  /events?token=   Server-Sent Events: friend-request, friend-accepted,
                        friend-declined, friend-removed, friend-request-cancelled,
                        typing, read, profile-updated, friends-changed and
                        prefs-changed (my other devices), signed-out
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import socket
import sqlite3
import subprocess
import threading
import time
from email.message import EmailMessage
from urllib.parse import parse_qs, urlsplit

import social
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SOJUCTL = ["sojuctl", "-config", os.environ.get("SOJU_CONFIG", "/soju-config")]
UPSTREAM_ADDR = os.environ.get("UPSTREAM_ADDR", "irc+insecure://solanum:6667")
NETWORK_NAME = os.environ.get("NETWORK_NAME", "solanum")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "8080"))
SOJU_ADDR = (os.environ.get("SOJU_IRC_HOST", "soju"), int(os.environ.get("SOJU_IRC_PORT", "6667")))
DB_PATH = os.path.join(os.environ.get("DATA_DIR", "/data"), "register.db")

SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_SECURITY = os.environ.get("SMTP_SECURITY", "starttls").lower()   # starttls | ssl | none
MAIL_FROM = os.environ.get("MAIL_FROM", "a09f <no-reply@a09f.invalid>")

RESET_CODE_TTL = 15 * 60          # seconds a reset code stays valid
RESET_MAX_TRIES = 5               # wrong codes before it's burned
RESET_COOLDOWN = 60               # seconds between codes for one account

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
EMAIL_RE = re.compile(r"^[^@\s<>\"',;]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")

_lock = threading.Lock()              # serialize sojuctl mutations
_attempts = defaultdict(deque)        # ip -> timestamps
_creates = defaultdict(deque)
_login_fails = defaultdict(deque)     # "ip|username" -> timestamps of wrong passwords
MAX_LOGIN_FAILS_PER_HOUR = int(os.environ.get("MAX_LOGIN_FAILS_PER_HOUR", "10"))
ADMINS = {u.strip().lower() for u in os.environ.get("ADMIN_USERS", "").split(",") if u.strip()}


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
    validate_password(password)


def validate_password(password):
    if not isinstance(password, str) or not (MIN_PASSWORD <= len(password) <= MAX_PASSWORD):
        raise Fail(400, f"Password must be at least {MIN_PASSWORD} characters.")
    # sojuctl speaks a line-based protocol to soju; never let control
    # characters (CR/LF/NUL...) reach it.
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in password):
        raise Fail(400, "Password contains characters that aren't allowed.")
    # The desktop app reuses this password for the account's NickServ (Atheme)
    # registration, and Atheme passwords can't contain spaces.
    if any(c.isspace() for c in password):
        raise Fail(400, "Password can't contain spaces.")


def validate_email(email):
    if not isinstance(email, str) or len(email) > 254 or not EMAIL_RE.match(email):
        raise Fail(400, "Please enter a valid email address.")
    return email


def mask_email(email):
    local, _, domain = email.partition("@")
    return (local[0] + "***" if local else "***") + "@" + domain


# ---------- storage ----------

def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("CREATE TABLE IF NOT EXISTS emails (username TEXT PRIMARY KEY, email TEXT NOT NULL, "
                 "updated INTEGER NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS resets (username TEXT PRIMARY KEY, code_hash TEXT NOT NULL, "
                 "expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL)")
    social.init_schema(conn)
    return conn


_exists_cache = {}          # username -> (exists, checked_at)


_users_cache = {"at": 0.0, "users": []}


def all_users():
    """Every soju account ID (sojuctl "user status" lists them), cached a minute."""
    if time.time() - _users_cache["at"] > 60:
        rc, out = sojuctl("user", "status")
        if rc == 0:
            users = [l.split(":", 1)[0].strip() for l in out.splitlines() if ":" in l]
            _users_cache.update(at=time.time(), users=[u for u in users if USERNAME_RE.match(u)])
    return _users_cache["users"]


def user_exists(username):
    if not USERNAME_RE.match(username or ""):
        return False
    hit = _exists_cache.get(username)
    if hit and time.time() - hit[1] < 300:
        return hit[0]
    rc, _ = sojuctl("user", "status", username)
    _exists_cache[username] = (rc == 0, time.time())
    return rc == 0


def get_email(username):
    with db() as conn:
        row = conn.execute("SELECT email FROM emails WHERE username = ?", (username,)).fetchone()
    return row[0] if row else None


def set_email(username, email):
    with db() as conn:
        conn.execute("INSERT INTO emails (username, email, updated) VALUES (?, ?, ?) "
                     "ON CONFLICT(username) DO UPDATE SET email = excluded.email, updated = excluded.updated",
                     (username, email, int(time.time())))


def code_hash(username, code):
    return hashlib.sha256(f"{username}:{code}".encode()).hexdigest()


# ---------- email ----------

def send_mail(to, subject, body):
    if not SMTP_HOST:
        raise RuntimeError("SMTP_HOST is not configured")
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = MAIL_FROM, to, subject
    msg.set_content(body)
    if SMTP_SECURITY == "ssl":
        smtp = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=20)
    else:
        smtp = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20)
    with smtp:
        if SMTP_SECURITY == "starttls":
            smtp.starttls()
        if SMTP_USER:
            smtp.login(SMTP_USER, SMTP_PASSWORD)
        smtp.send_message(msg)


# ---------- password check (real SASL login to soju) ----------

def check_login(username, password):
    """True if soju accepts these credentials (SASL PLAIN on the bouncer port)."""
    try:
        with socket.create_connection(SOJU_ADDR, timeout=10) as s:
            f = s.makefile("rwb", buffering=0)
            auth = base64.b64encode(f"\0{username}\0{password}".encode()).decode()
            for line in ("CAP REQ :sasl", "NICK a09f-check", "USER a09f-check 0 * :check",
                         "AUTHENTICATE PLAIN"):
                s.sendall((line + "\r\n").encode())
            deadline = time.time() + 10
            while time.time() < deadline:
                line = f.readline().decode(errors="replace").strip()
                if not line:
                    return False
                parts = line.split()
                if parts[0] == "AUTHENTICATE":
                    s.sendall(f"AUTHENTICATE {auth}\r\n".encode())
                elif len(parts) > 1 and parts[1] == "903":
                    return True
                elif len(parts) > 1 and parts[1] in ("902", "904", "905", "906", "907"):
                    return False
    except OSError as e:
        print(f"[register] login check error: {e!r}", flush=True)
        raise Fail(503, "Can't check your password right now. Please try again later.")
    return False


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


# ---------- forgot password ----------

def reset_request(username):
    if not USERNAME_RE.match(username):
        raise Fail(400, "Please enter your a09f ID.")
    rc, _ = sojuctl("user", "status", username)
    if rc != 0:
        raise Fail(404, "There's no a09f account with that ID.")
    email = get_email(username)
    if not email:
        raise Fail(409, "This account has no recovery email, so its password can't be reset here. "
                        "Please contact the a09f admin.")
    now = int(time.time())
    with db() as conn:
        row = conn.execute("SELECT sent FROM resets WHERE username = ?", (username,)).fetchone()
        if row and now - row[0] < RESET_COOLDOWN:
            raise Fail(429, "We just sent you a code. Please check your email, or wait a minute to get a new one.")
        code = f"{secrets.randbelow(10**6):06d}"
        conn.execute("INSERT OR REPLACE INTO resets (username, code_hash, expires, tries, sent) "
                     "VALUES (?, ?, ?, 0, ?)", (username, code_hash(username, code), now + RESET_CODE_TTL, now))
    try:
        send_mail(email, "Your a09f password reset code",
                  f"Hi {username},\n\n"
                  f"Your a09f password reset code is: {code}\n\n"
                  f"Enter it in the a09f app within {RESET_CODE_TTL // 60} minutes to choose a new password.\n"
                  "If you didn't ask for this, you can ignore this email: your password stays the same.\n")
    except Exception as e:
        print(f"[register] reset mail for {username} failed: {e!r}", flush=True)
        with db() as conn:
            conn.execute("DELETE FROM resets WHERE username = ?", (username,))
        raise Fail(503, "Couldn't send the email right now. Please try again later.")
    print(f"[register] reset code sent for {username}", flush=True)
    return mask_email(email)


def reset_confirm(username, code, password):
    bad = Fail(400, "That code isn't right, or it has expired. Please check it or ask for a new one.")
    if not USERNAME_RE.match(username) or not isinstance(code, str):
        raise bad
    code = code.strip()
    validate_password(password)
    now = int(time.time())
    with db() as conn:
        row = conn.execute("SELECT code_hash, expires, tries FROM resets WHERE username = ?",
                           (username,)).fetchone()
        if not row or row[1] < now or row[2] >= RESET_MAX_TRIES:
            raise bad
        if not hmac.compare_digest(row[0], code_hash(username, code)):
            conn.execute("UPDATE resets SET tries = tries + 1 WHERE username = ?", (username,))
            raise bad
        conn.execute("DELETE FROM resets WHERE username = ?", (username,))
    set_password(username, password)
    social.end_user_sessions(username)
    social.push(username, "signed-out", {"except": "", "reason": "password"})


def set_password(username, password):
    """Change the password in soju, then NickServ + soju's SASL login if linked."""
    with _lock:
        rc, out = sojuctl("user", "update", username, "-password", password)
        if rc != 0:
            print(f"[register] password update {username} failed: {out}", flush=True)
            raise Fail(500, "Couldn't change your password right now. Please try again later.")
        # NickServ: only possible while soju's upstream is identified as this
        # account; it then also needs soju's stored SASL password updated.
        rc, out = sojuctl("user", "run", username, "sasl", "status", "-network", NETWORK_NAME)
        if rc == 0 and f'account "{username}"' in out.lower():
            sojuctl("user", "run", username, "network", "quote", NETWORK_NAME,
                    f"PRIVMSG NickServ :SET PASSWORD {password}")
            time.sleep(1.5)
            rc, out = sojuctl("user", "run", username, "sasl", "set-plain", "-network", NETWORK_NAME,
                              username, password)
            if rc != 0:
                print(f"[register] sasl update {username} failed: {out}", flush=True)
    print(f"[register] password reset for {username}", flush=True)


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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _token_user(self, token=None):
        if token is None:
            auth = self.headers.get("Authorization", "")
            token = auth[7:] if auth.startswith("Bearer ") else ""
        user = social.session_user(token)
        if not user:
            raise Fail(401, "Please sign in again.")
        return user

    def do_GET(self):
        url = urlsplit(self.path)
        try:
            if url.path == "/health":
                self._json(200, {"ok": True})
            elif url.path == "/events":
                me = self._token_user(parse_qs(url.query).get("token", [""])[0])
                social.serve_events(self, me)
                if not social.is_listening(me):          # closed their last window
                    with db() as conn:
                        social.touch_last_seen(conn, me)
            elif url.path == "/friends":
                me = self._token_user()
                with db() as conn:
                    self._json(200, {"ok": True, **social.friends_state(conn, me)})
            elif url.path == "/stats":
                self._token_user()
                self._json(200, {"ok": True, "online": social.online_count()})
            elif url.path == "/redactions":
                self._token_user()
                since = parse_qs(url.query).get("since", ["0"])[0]
                with db() as conn:
                    self._json(200, {"ok": True, "redactions": social.redactions_since(conn, int(since or 0))})
            elif url.path == "/announcements":
                self._token_user()
                after = parse_qs(url.query).get("after", ["0"])[0]
                with db() as conn:
                    self._json(200, {"ok": True, "announcements": social.announcements_since(conn, int(after or 0))})
            elif url.path in ("/saved", "/trending", "/imv"):
                me = self._token_user()
                with db() as conn:
                    if url.path == "/saved":
                        out = {"saved": social.saved_list(conn, me)}
                    elif url.path == "/trending":
                        out = {"trending": social.trending(conn)}
                    else:
                        other = parse_qs(url.query).get("with", [""])[0].lower()
                        if not USERNAME_RE.match(other):
                            raise Fail(400, "Bad request.")
                        out = social.get_imv(conn, me, other)
                self._json(200, {"ok": True, **out})
            elif url.path == "/namecolors":
                self._token_user()
                users = [u for u in parse_qs(url.query).get("users", [""])[0].lower().split(",") if USERNAME_RE.match(u)]
                with db() as conn:
                    self._json(200, {"ok": True, "colors": social.name_colors(conn, users)})
            elif url.path in ("/msgmeta", "/poll", "/lastseen", "/reminders", "/reminders/due"):
                me = self._token_user()
                q = parse_qs(url.query)
                with db() as conn:
                    try:
                        if url.path == "/msgmeta":
                            cv = q.get("conv", [""])[0].strip().lower()
                            out = {"reactions": social.reactions_for(conn, me, cv), "edits": social.edits_for(conn, me, cv),
                                   "expiring": social.expiries_for(conn, me, cv),
                                   "pins": social.pins_for(conn, cv) if cv.startswith(("#", "&")) else []}
                        elif url.path == "/poll":
                            out = social.poll_state(conn, me, int(q.get("id", ["0"])[0] or 0))
                        elif url.path == "/lastseen":
                            users = [u for u in q.get("users", [""])[0].lower().split(",") if USERNAME_RE.match(u)]
                            out = {"lastSeen": social.last_seen(conn, users)}
                        elif url.path == "/reminders":
                            out = {"reminders": social.pending_reminders(conn, me)}
                        else:
                            due = social.due_reminders(conn, me)
                            social.mark_delivered(conn, [r["id"] for r in due])
                            out = {"reminders": due}
                    except social.SocialFail as f:
                        raise Fail(f.status, f.message)
                self._json(200, {"ok": True, **out})
            elif url.path == "/prefs":
                me = self._token_user()
                with db() as conn:
                    self._json(200, {"ok": True, **social.get_prefs(conn, me)})
            elif url.path == "/users/search":
                me = self._token_user()
                q = parse_qs(url.query).get("q", [""])[0]
                try:
                    users = social.search_users(all_users(), me, q)
                except social.SocialFail as f:
                    raise Fail(f.status, f.message)
                self._json(200, {"ok": True, "users": users})
            else:
                self._json(404, {"ok": False, "error": "not found"})
        except Fail as f:
            self._json(f.status, {"ok": False, "error": f.message})

    # Signed-in calls (bearer token): not counted against the per-IP limit.
    SOCIAL = {"/friends/request", "/friends/respond", "/friends/remove", "/friends/move",
              "/friends/rename-group", "/typing", "/session/end", "/prefs", "/read",
              "/profile/updated", "/session/revoke-others", "/redact", "/announce",
              "/react", "/edit", "/pin", "/poll/create", "/poll/vote", "/remind", "/namecolor",
              "/expire", "/save", "/activity", "/imv"}

    def do_POST(self):
        if self.path in self.SOCIAL:
            self._social_post()
            return
        routes = {"/register": self._register, "/reset/request": self._reset_request,
                  "/reset/confirm": self._reset_confirm, "/email": self._email,
                  "/session": self._session}
        route = routes.get(self.path)
        if not route:
            self._json(404, {"ok": False, "error": "not found"})
            return
        ip = self.client_address[0]
        try:
            # Password checks (/session, /email) are limited per IP+ID on wrong
            # passwords only (see _password_ok): signing in must never use up
            # a budget shared by everyone behind the same address.
            if self.path not in ("/session", "/email"):
                if over_limit(_attempts, ip, MAX_ATTEMPTS_PER_HOUR):
                    raise Fail(429, "Too many tries. Please wait a while and try again.")
                _attempts[ip].append(time.monotonic())

            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 4096:
                raise Fail(400, "Please fill in all the fields.")
            try:
                body = json.loads(self.rfile.read(length))
            except ValueError:
                raise Fail(400, "Please fill in all the fields.")
            if not isinstance(body, dict):
                raise Fail(400, "Please fill in all the fields.")
            username = str(body.get("username", "")).strip().lower()
            route(ip, username, body)
        except Fail as f:
            self._json(f.status, {"ok": False, "error": f.message})
        except Exception as e:  # never leak internals to the client
            print(f"[register] error: {e!r}", flush=True)
            self._json(500, {"ok": False, "error": "Something went wrong. Please try again later."})

    def _register(self, ip, username, body):
        if over_limit(_creates, ip, MAX_CREATES_PER_HOUR):
            raise Fail(429, "Too many tries. Please wait a while and try again.")
        password = body.get("password", "")
        validate(username, password)
        email = validate_email(str(body.get("email", "")).strip())
        create_account(username, password)
        set_email(username, email)
        _creates[ip].append(time.monotonic())
        self._json(201, {"ok": True, "username": username})

    def _reset_request(self, ip, username, body):
        self._json(200, {"ok": True, "email": reset_request(username)})

    def _reset_confirm(self, ip, username, body):
        reset_confirm(username, body.get("code", ""), body.get("password", ""))
        self._json(200, {"ok": True, "username": username})

    def _email(self, ip, username, body):
        self._password_ok(ip, username, str(body.get("password", "")))
        if "email" in body:
            set_email(username, validate_email(str(body.get("email", "")).strip()))
        self._json(200, {"ok": True, "email": get_email(username) or ""})

    def _password_ok(self, ip, username, password):
        key = f"{ip}|{username}"
        if over_limit(_login_fails, key, MAX_LOGIN_FAILS_PER_HOUR):
            raise Fail(429, "Too many wrong passwords. Please wait a while and try again.")
        if USERNAME_RE.match(username) and check_login(username, password):
            return
        _login_fails[key].append(time.monotonic())
        raise Fail(403, "Your password isn't right.")

    def _session(self, ip, username, body):
        self._password_ok(ip, username, str(body.get("password", "")))
        token = social.new_session(username)
        self._json(200, {"ok": True, "token": token, "sid": social.sid_of(token), "admin": username in ADMINS})

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 4096:
            raise Fail(400, "Bad request.")
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            raise Fail(400, "Bad request.")
        if not isinstance(body, dict):
            raise Fail(400, "Bad request.")
        return body

    def _social_post(self):
        try:
            me = self._token_user()
            auth = self.headers.get("Authorization", "")
            token = auth[7:] if auth.startswith("Bearer ") else ""
            sid = social.sid_of(token)
            body = self._read_body()
            nick = lambda k: str(body.get(k, "")).strip().lower()
            if self.path == "/read":
                to = nick("to")
                if USERNAME_RE.match(to) and to != me:
                    social.push(to, "read", {"from": me, "time": int(body.get("time") or 0)})
                self._json(200, {"ok": True})
                return
            if self.path == "/redact":
                target = str(body.get("target", "")).strip().lower()
                h = str(body.get("hash", ""))[:16]
                try:
                    t = int(body.get("time"))
                except (TypeError, ValueError):
                    raise Fail(400, "Bad request.")
                if not target or not re.match(r"^[0-9a-z]{1,16}$", h):
                    raise Fail(400, "Bad request.")
                with db() as conn:
                    social.redact(conn, me, target, t, h)
                item = {"sender": me, "target": target, "time": t, "hash": h}
                if target.startswith(("#", "&")):
                    social.push_all("redact", item)
                else:
                    social.push(target, "redact", item)
                    social.push(me, "redact", item)
                self._json(200, {"ok": True})
                return
            if self.path == "/namecolor":
                with db() as conn:
                    try:
                        social.set_name_color(conn, me, body.get("color"))
                    except social.SocialFail as f:
                        raise Fail(f.status, f.message)
                self._json(200, {"ok": True})
                return
            if self.path == "/activity":
                room = nick("room")
                if room.startswith(("#", "&")) and len(room) <= 50 and not room.startswith("#conf-"):
                    with db() as conn:
                        social.note_activity(conn, room)
                self._json(200, {"ok": True})
                return
            if self.path == "/imv":
                other = nick("with")
                if not USERNAME_RE.match(other) or other == me:
                    raise Fail(400, "Bad request.")
                with db() as conn:
                    try:
                        social.set_imv(conn, me, other, str(body.get("theme", "")))
                    except social.SocialFail as f:
                        raise Fail(f.status, f.message)
                self._json(200, {"ok": True})
                return
            if self.path in ("/react", "/edit", "/pin", "/poll/create", "/poll/vote", "/remind", "/expire", "/save"):
                self._json(200, {"ok": True, **self._extras(me, body)})
                return
            if self.path == "/announce":
                if me not in ADMINS:
                    raise Fail(403, "Only a09f admins can send announcements.")
                with db() as conn:
                    try:
                        item = social.announce(conn, me, body.get("text"))
                    except social.SocialFail as f:
                        raise Fail(f.status, f.message)
                print(f"[register] announcement #{item['id']} by {me}", flush=True)
                self._json(200, {"ok": True, **item})
                return
            if self.path == "/profile/updated":
                with db() as conn:
                    social.push_friends(conn, me, "profile-updated", {"nick": me})
                social.push(me, "profile-updated", {"nick": me, "sid": sid})
                self._json(200, {"ok": True})
                return
            if self.path == "/session/revoke-others":
                social.end_user_sessions(me, keep_token=token)
                social.push(me, "signed-out", {"except": sid, "reason": "password"})
                self._json(200, {"ok": True})
                return
            if self.path == "/typing":
                to = nick("to")
                if to.startswith(("#", "&")) and len(to) <= 50:      # a room: apps keep what they're in
                    social.push_all("typing", {"from": me, "active": bool(body.get("active")), "room": to})
                elif USERNAME_RE.match(to) and to != me:
                    social.push(to, "typing", {"from": me, "active": bool(body.get("active"))})
                self._json(200, {"ok": True})
                return
            if self.path == "/session/end":
                auth = self.headers.get("Authorization", "")
                social.end_session(auth[7:])
                self._json(200, {"ok": True})
                return
            if self.path == "/prefs":
                with db() as conn:
                    try:
                        prefs = social.set_prefs(conn, me, body, lambda u: bool(USERNAME_RE.match(u)))
                    except social.SocialFail as f:
                        raise Fail(f.status, f.message)
                social.push(me, "prefs-changed", {"sid": sid})
                self._json(200, {"ok": True, **prefs})
                return
            with db() as conn:
                try:
                    if self.path == "/friends/request":
                        to = nick("to")
                        if not USERNAME_RE.match(to):
                            raise Fail(400, "That doesn't look like an a09f ID.")
                        result = social.request_friend(conn, me, to, body.get("group"), body.get("msg"), user_exists)
                    elif self.path == "/friends/respond":
                        social.respond_friend(conn, me, nick("from"), bool(body.get("accept")), body.get("group"))
                        result = "ok"
                    elif self.path == "/friends/remove":
                        social.remove_friend(conn, me, nick("nick"))
                        result = "ok"
                    elif self.path == "/friends/move":
                        social.move_friend(conn, me, nick("nick"), body.get("group"))
                        result = "ok"
                    else:   # /friends/rename-group
                        social.rename_group(conn, me, str(body.get("from", "")), body.get("to"))
                        result = "ok"
                except social.SocialFail as f:
                    raise Fail(f.status, f.message)
                social.push(me, "friends-changed", {"sid": sid})      # my other devices
                self._json(200, {"ok": True, "result": result, **social.friends_state(conn, me)})
        except Fail as f:
            self._json(f.status, {"ok": False, "error": f.message})
        except Exception as e:
            print(f"[register] social error: {e!r}", flush=True)
            self._json(500, {"ok": False, "error": "Something went wrong. Please try again later."})

    def _extras(self, me, body):
        def msg_key(sender_default=None):
            sender = str(body.get("sender", sender_default or "")).strip().lower()
            target = str(body.get("target", body.get("room", ""))).strip().lower()
            h = str(body.get("hash", ""))[:16]
            try:
                t = int(body.get("time"))
            except (TypeError, ValueError):
                raise Fail(400, "Bad request.")
            if not USERNAME_RE.match(sender) or not target or not re.match(r"^[0-9a-z]{1,16}$", h):
                raise Fail(400, "Bad request.")
            return (sender, target, t, h)
        with db() as conn:
            try:
                if self.path == "/react":
                    social.react(conn, me, msg_key(), str(body.get("emoji", "")), bool(body.get("on")))
                    return {}
                if self.path == "/edit":
                    social.edit(conn, me, msg_key(me), body.get("text"))
                    return {}
                if self.path == "/pin":
                    room = str(body.get("room", "")).strip().lower()
                    if not room.startswith(("#", "&")):
                        raise Fail(400, "Only room messages can be pinned.")
                    social.pin(conn, me, room, msg_key(), body.get("text"), bool(body.get("on")))
                    return {}
                if self.path == "/poll/create":
                    room = str(body.get("room", "")).strip().lower()
                    if not room.startswith(("#", "&")):
                        raise Fail(400, "Polls are for rooms.")
                    return {"id": social.create_poll(conn, me, room, body.get("question"), body.get("options"))}
                if self.path == "/poll/vote":
                    opt = body.get("option")
                    social.vote(conn, me, int(body.get("id") or 0), None if opt is None else int(opt))
                    return {}
                if self.path == "/remind":
                    return social.add_reminder(conn, me, body.get("text"), body.get("minutes"))
                if self.path == "/expire":
                    social.set_expiry(conn, me, msg_key(me), body.get("after") or 0)
                    return {}
                if self.path == "/save":
                    social.save_message(conn, me, msg_key(), body.get("conv", ""), body.get("text"), bool(body.get("on")))
                    return {}
            except social.SocialFail as f:
                raise Fail(f.status, f.message)
        return {}

    def log_message(self, fmt, *args):
        # Request line only (no bodies/passwords); never print the SSE token,
        # and skip the chatty typing pings unless they fail.
        line = re.sub(r"token=[^ &\"]+", "token=<redacted>", fmt % args)
        if ("/typing" in line or "/events" in line) and '" 200 ' in line:
            return
        print(f"[register] {self.client_address[0]} {line}", flush=True)


def reminder_loop():
    """Deliver due reminders to people who have a09f open; the rest get them
    from /reminders/due when they sign in."""
    while True:
        time.sleep(10)
        try:
            with db() as conn:
                due = [r for r in social.due_reminders(conn) if social.is_listening(r["user"])]
                for r in due:
                    social.push(r["user"], "reminder", r)
                social.mark_delivered(conn, [r["id"] for r in due])
                social.expire_due(conn)
        except Exception as e:
            print(f"[register] reminder loop: {e!r}", flush=True)


if __name__ == "__main__":
    db().close()
    threading.Thread(target=reminder_loop, daemon=True).start()
    print(f"[register] listening on :{LISTEN_PORT}, network {NETWORK_NAME} -> {UPSTREAM_ADDR}, "
          f"smtp {SMTP_HOST or 'NOT CONFIGURED'}:{SMTP_PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler).serve_forever()
