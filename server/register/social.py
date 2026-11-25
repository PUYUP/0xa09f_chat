"""a09f social features for the account service: sessions, friends, live events.

Kept server-side (not on IRC) because:
  * the friends list should follow a person to any computer, and adding a
    friend needs the other person's approval (both lists change together);
  * typing notifications must not land in soju's chat history, and solanum
    drops TAGMSG / client tags, so IRC can't carry them.

Sessions: POST /session (password checked by a real SASL login to soju)
returns a bearer token, kept in memory only: after a restart the app simply
signs in again. Live events go out over Server-Sent Events (GET /events).
"""

import hashlib
import json
import queue
import secrets
import threading
import time

SESSION_TTL = 7 * 24 * 3600
MAX_GROUP_LEN = 24
MAX_REQUEST_MSG = 140
DEFAULT_GROUP = "Friends"

_sessions = {}                  # token -> (username, expires)
_listeners = {}                 # username -> set(queue.Queue)
_mu = threading.Lock()


class SocialFail(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def init_schema(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS friends (owner TEXT NOT NULL, friend TEXT NOT NULL, "
                 "grp TEXT NOT NULL, added INTEGER NOT NULL, PRIMARY KEY (owner, friend))")
    conn.execute("CREATE TABLE IF NOT EXISTS prefs (owner TEXT PRIMARY KEY, data TEXT NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS friend_requests (from_user TEXT NOT NULL, to_user TEXT NOT NULL, "
                 "grp TEXT NOT NULL, msg TEXT NOT NULL, created INTEGER NOT NULL, "
                 "PRIMARY KEY (from_user, to_user))")


# ---------- sessions ----------

def new_session(username):
    token = secrets.token_urlsafe(32)
    with _mu:
        now = time.time()
        for t, (_, exp) in list(_sessions.items()):     # drop expired ones
            if exp < now:
                del _sessions[t]
        _sessions[token] = (username, now + SESSION_TTL)
    return token


def session_user(token):
    with _mu:
        s = _sessions.get(token or "")
        if not s or s[1] < time.time():
            return None
        return s[0]


def end_session(token):
    with _mu:
        _sessions.pop(token, None)


def sid_of(token):
    """Short public id of a session: lets a device recognise its own events."""
    return hashlib.sha256((token or "").encode()).hexdigest()[:12]


def end_user_sessions(username, keep_token=None):
    with _mu:
        for t, (u, _) in list(_sessions.items()):
            if u == username and t != keep_token:
                del _sessions[t]


def push_friends(conn, me, event, data):
    for (f,) in conn.execute("SELECT friend FROM friends WHERE owner = ?", (me,)):
        push(f, event, data)


# ---------- live events ----------

def subscribe(username):
    q = queue.Queue(maxsize=200)
    with _mu:
        _listeners.setdefault(username, set()).add(q)
    return q


def unsubscribe(username, q):
    with _mu:
        qs = _listeners.get(username)
        if qs:
            qs.discard(q)
            if not qs:
                del _listeners[username]


def push(username, event, data):
    with _mu:
        qs = list(_listeners.get(username, ()))
    for q in qs:
        try:
            q.put_nowait((event, data))
        except queue.Full:
            pass


def is_listening(username):
    with _mu:
        return username in _listeners


def serve_events(handler, username):
    """Stream events to one client until it disconnects."""
    q = subscribe(username)
    try:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Cache-Control", "no-cache")
        handler._cors()
        handler.end_headers()
        handler.wfile.write(b": connected\n\n")
        handler.wfile.flush()
        while True:
            try:
                event, data = q.get(timeout=25)
                chunk = f"event: {event}\ndata: {json.dumps(data)}\n\n"
            except queue.Empty:
                chunk = ": keepalive\n\n"        # also detects dead connections
            handler.wfile.write(chunk.encode())
            handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        unsubscribe(username, q)


# ---------- friends ----------

def clean_group(g):
    g = " ".join(str(g or "").split())[:MAX_GROUP_LEN]
    return g or DEFAULT_GROUP


def friends_state(conn, me):
    friends = [{"nick": f, "group": g} for f, g in
               conn.execute("SELECT friend, grp FROM friends WHERE owner = ? ORDER BY friend", (me,))]
    incoming = [{"from": f, "msg": m, "created": c} for f, m, c in
                conn.execute("SELECT from_user, msg, created FROM friend_requests WHERE to_user = ? "
                             "ORDER BY created", (me,))]
    outgoing = [{"to": t, "group": g} for t, g in
                conn.execute("SELECT to_user, grp FROM friend_requests WHERE from_user = ? ORDER BY to_user", (me,))]
    return {"friends": friends, "incoming": incoming, "outgoing": outgoing}


def _befriend(conn, a, b, grp_a, grp_b):
    now = int(time.time())
    conn.execute("INSERT OR IGNORE INTO friends (owner, friend, grp, added) VALUES (?, ?, ?, ?)", (a, b, grp_a, now))
    conn.execute("INSERT OR IGNORE INTO friends (owner, friend, grp, added) VALUES (?, ?, ?, ?)", (b, a, grp_b, now))
    conn.execute("DELETE FROM friend_requests WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)",
                 (a, b, b, a))


def request_friend(conn, me, to, group, msg, user_exists):
    group = clean_group(group)
    msg = " ".join(str(msg or "").split())[:MAX_REQUEST_MSG]
    if to == me:
        raise SocialFail(400, "That's you!")
    if conn.execute("SELECT 1 FROM friends WHERE owner = ? AND friend = ?", (me, to)).fetchone():
        raise SocialFail(409, f"{to} is already your friend.")
    if not user_exists(to):
        raise SocialFail(404, f"There's no a09f user with the ID \"{to}\".")
    # They already asked us: that's a yes from both sides.
    theirs = conn.execute("SELECT grp FROM friend_requests WHERE from_user = ? AND to_user = ?", (to, me)).fetchone()
    if theirs:
        _befriend(conn, me, to, group, theirs[0])
        push(to, "friend-accepted", {"nick": me})
        return "friends"
    # Already friends from their side only (we removed them earlier): just re-add.
    if conn.execute("SELECT 1 FROM friends WHERE owner = ? AND friend = ?", (to, me)).fetchone():
        conn.execute("INSERT OR IGNORE INTO friends (owner, friend, grp, added) VALUES (?, ?, ?, ?)",
                     (me, to, group, int(time.time())))
        return "friends"
    conn.execute("INSERT OR REPLACE INTO friend_requests (from_user, to_user, grp, msg, created) "
                 "VALUES (?, ?, ?, ?, ?)", (me, to, group, msg, int(time.time())))
    push(to, "friend-request", {"from": me, "msg": msg})
    return "requested"


def respond_friend(conn, me, frm, accept, group):
    row = conn.execute("SELECT grp FROM friend_requests WHERE from_user = ? AND to_user = ?", (frm, me)).fetchone()
    if not row:
        raise SocialFail(404, "That friend request isn't there any more.")
    if accept:
        _befriend(conn, me, frm, clean_group(group), row[0])
        push(frm, "friend-accepted", {"nick": me})
    else:
        conn.execute("DELETE FROM friend_requests WHERE from_user = ? AND to_user = ?", (frm, me))
        push(frm, "friend-declined", {"nick": me})


def remove_friend(conn, me, nick):
    """End a friendship on both sides (or cancel my pending request)."""
    was_friends = conn.execute("SELECT 1 FROM friends WHERE (owner = ? AND friend = ?) OR (owner = ? AND friend = ?)",
                               (me, nick, nick, me)).fetchone()
    had_request = conn.execute("SELECT 1 FROM friend_requests WHERE from_user = ? AND to_user = ?",
                               (me, nick)).fetchone()
    conn.execute("DELETE FROM friends WHERE (owner = ? AND friend = ?) OR (owner = ? AND friend = ?)",
                 (me, nick, nick, me))
    conn.execute("DELETE FROM friend_requests WHERE from_user = ? AND to_user = ?", (me, nick))
    if was_friends:
        push(nick, "friend-removed", {"nick": me})
    elif had_request:
        push(nick, "friend-request-cancelled", {"nick": me})


def move_friend(conn, me, nick, group):
    conn.execute("UPDATE friends SET grp = ? WHERE owner = ? AND friend = ?", (clean_group(group), me, nick))
    conn.execute("UPDATE friend_requests SET grp = ? WHERE from_user = ? AND to_user = ?", (clean_group(group), me, nick))


def rename_group(conn, me, old, new):
    new = clean_group(new)
    conn.execute("UPDATE friends SET grp = ? WHERE owner = ? AND grp = ?", (new, me, old))
    conn.execute("UPDATE friend_requests SET grp = ? WHERE from_user = ? AND grp = ?", (new, me, old))


# ---------- privacy preferences ----------

MAX_IGNORE = 200
PREF_DEFAULTS = {"ignore": [], "friendsOnly": False}


def get_prefs(conn, me):
    row = conn.execute("SELECT data FROM prefs WHERE owner = ?", (me,)).fetchone()
    prefs = dict(PREF_DEFAULTS)
    if row:
        try:
            prefs.update(json.loads(row[0]))
        except ValueError:
            pass
    return prefs


def set_prefs(conn, me, body, valid_id):
    prefs = get_prefs(conn, me)
    if "ignore" in body:
        ids = body["ignore"] if isinstance(body["ignore"], list) else []
        clean = sorted({str(i).strip().lower() for i in ids if valid_id(str(i).strip().lower())} - {me})
        if len(clean) > MAX_IGNORE:
            raise SocialFail(400, f"You can ignore at most {MAX_IGNORE} people.")
        prefs["ignore"] = clean
    if "friendsOnly" in body:
        prefs["friendsOnly"] = bool(body["friendsOnly"])
    conn.execute("INSERT INTO prefs (owner, data) VALUES (?, ?) ON CONFLICT(owner) DO UPDATE SET data = excluded.data",
                 (me, json.dumps(prefs)))
    return prefs


# ---------- find people ----------

def search_users(all_users, me, q, limit=20):
    q = q.strip().lower()
    if len(q) < 2:
        raise SocialFail(400, "Type at least 2 letters.")
    hits = [u for u in all_users if q in u and u != me]
    hits.sort(key=lambda u: (not u.startswith(q), len(u), u))
    return hits[:limit]
