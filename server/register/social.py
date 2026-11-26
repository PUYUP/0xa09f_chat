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
    conn.execute("CREATE TABLE IF NOT EXISTS redactions (sender TEXT NOT NULL, target TEXT NOT NULL, "
                 "time INTEGER NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL, "
                 "PRIMARY KEY (sender, target, time, hash))")
    # Messages are identified like redactions: sender, target (room or the
    # person it was sent to), server time (ms) and a hash of the text.
    conn.execute("CREATE TABLE IF NOT EXISTS reactions (sender TEXT NOT NULL, target TEXT NOT NULL, time INTEGER NOT NULL, "
                 "hash TEXT NOT NULL, user TEXT NOT NULL, emoji TEXT NOT NULL, created INTEGER NOT NULL, "
                 "PRIMARY KEY (sender, target, time, hash, user, emoji))")
    conn.execute("CREATE TABLE IF NOT EXISTS edits (sender TEXT NOT NULL, target TEXT NOT NULL, time INTEGER NOT NULL, "
                 "hash TEXT NOT NULL, text TEXT NOT NULL, edited INTEGER NOT NULL, "
                 "PRIMARY KEY (sender, target, time, hash))")
    conn.execute("CREATE TABLE IF NOT EXISTS pins (room TEXT NOT NULL, sender TEXT NOT NULL, time INTEGER NOT NULL, "
                 "hash TEXT NOT NULL, text TEXT NOT NULL, pinned_by TEXT NOT NULL, created INTEGER NOT NULL, "
                 "PRIMARY KEY (room, sender, time, hash))")
    conn.execute("CREATE TABLE IF NOT EXISTS polls (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, "
                 "author TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL, created INTEGER NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS poll_votes (poll INTEGER NOT NULL, user TEXT NOT NULL, option INTEGER NOT NULL, "
                 "PRIMARY KEY (poll, user))")
    conn.execute("CREATE TABLE IF NOT EXISTS last_seen (user TEXT PRIMARY KEY, time INTEGER NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, "
                 "text TEXT NOT NULL, due INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)")
    conn.execute("CREATE TABLE IF NOT EXISTS name_colors (user TEXT PRIMARY KEY, color TEXT NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS expiring (sender TEXT NOT NULL, target TEXT NOT NULL, time INTEGER NOT NULL, "
                 "hash TEXT NOT NULL, due INTEGER NOT NULL, PRIMARY KEY (sender, target, time, hash))")
    conn.execute("CREATE TABLE IF NOT EXISTS saved (user TEXT NOT NULL, sender TEXT NOT NULL, target TEXT NOT NULL, "
                 "time INTEGER NOT NULL, hash TEXT NOT NULL, conv TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL, "
                 "PRIMARY KEY (user, sender, target, time, hash))")
    conn.execute("CREATE TABLE IF NOT EXISTS room_activity (room TEXT NOT NULL, day TEXT NOT NULL, msgs INTEGER NOT NULL, "
                 "PRIMARY KEY (room, day))")
    conn.execute("CREATE TABLE IF NOT EXISTS imv (pair TEXT PRIMARY KEY, theme TEXT NOT NULL, by_user TEXT NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS user_tz (user TEXT PRIMARY KEY, tz TEXT NOT NULL, offset INTEGER NOT NULL, "
                 "updated INTEGER NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS room_tz (room TEXT NOT NULL, day TEXT NOT NULL, offset INTEGER NOT NULL, "
                 "msgs INTEGER NOT NULL, PRIMARY KEY (room, day, offset))")
    conn.execute("CREATE TABLE IF NOT EXISTS scheduled (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, "
                 "target TEXT NOT NULL, text TEXT NOT NULL, due INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0)")
    conn.execute("CREATE TABLE IF NOT EXISTS user_active (user TEXT PRIMARY KEY, start INTEGER NOT NULL, end INTEGER NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                 "author TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL)")
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
    online_changed()
    return q


def unsubscribe(username, q):
    with _mu:
        qs = _listeners.get(username)
        if qs:
            qs.discard(q)
            if not qs:
                del _listeners[username]
    online_changed()


def online_count():
    with _mu:
        return len(_listeners)


def push_all(event, data):
    with _mu:
        users = list(_listeners)
    for u in users:
        push(u, event, data)


_online_timer = None


def online_changed():
    """Tell everyone how many people have a09f open (debounced)."""
    global _online_timer
    with _mu:
        if _online_timer:
            return
        _online_timer = threading.Timer(2.0, _send_online)
        _online_timer.daemon = True
        _online_timer.start()


def _send_online():
    global _online_timer
    with _mu:
        _online_timer = None
    push_all("online", {"count": online_count()})


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


# ---------- deleted messages ----------

MAX_REDACT_AGE = 30 * 24 * 3600


def redact(conn, me, target, msg_time, text_hash):
    """Remember that `me` deleted their message (target, time, hash). Returns
    the people to tell: the other person of a private chat, or everyone for
    a room (the service doesn't know who's in it)."""
    conn.execute("INSERT OR IGNORE INTO redactions (sender, target, time, hash, created) VALUES (?, ?, ?, ?, ?)",
                 (me, target, int(msg_time), text_hash, int(time.time())))
    conn.execute("DELETE FROM redactions WHERE created < ?", (int(time.time()) - MAX_REDACT_AGE,))


def redactions_since(conn, since):
    rows = conn.execute("SELECT sender, target, time, hash FROM redactions WHERE created >= ? ORDER BY created",
                        (int(since),))
    return [{"sender": a, "target": b, "time": c, "hash": d} for a, b, c, d in rows]


# ---------- announcements (admins) ----------

def announce(conn, me, text):
    text = " ".join(str(text or "").split())[:500]
    if not text:
        raise SocialFail(400, "Please write the announcement first.")
    cur = conn.execute("INSERT INTO announcements (author, text, created) VALUES (?, ?, ?)",
                       (me, text, int(time.time())))
    item = {"id": cur.lastrowid, "author": me, "text": text, "created": int(time.time())}
    push_all("announcement", item)
    return item


def announcements_since(conn, after_id, max_age=7 * 24 * 3600):
    rows = conn.execute("SELECT id, author, text, created FROM announcements WHERE id > ? AND created >= ? "
                        "ORDER BY id DESC LIMIT 5", (int(after_id), int(time.time()) - max_age))
    return [{"id": i, "author": a, "text": t, "created": c} for i, a, t, c in rows][::-1]


# ---------- message extras: reactions, edits, pins ----------

REACTIONS = {"👍", "❤️", "😂", "😮", "😢", "🙏", "🎉", "🔥"}


def msg_audience(target, sender):
    """Who should hear about a change to a message: everyone for a room
    (the service doesn't know who's in it), else both people of the chat."""
    return None if target.startswith(("#", "&")) else {target, sender}


def tell(audience, me, event, data):
    if audience is None:
        push_all(event, data)
    else:
        for u in audience | {me}:
            push(u, event, data)


def conv_filter(me, conv):
    """SQL filter for a conversation: a room, or the private chat me<->conv."""
    if conv.startswith(("#", "&")):
        return "target = ?", (conv,)
    return "((sender = ? AND target = ?) OR (sender = ? AND target = ?))", (me, conv, conv, me)


def react(conn, me, key, emoji, on):
    if emoji not in REACTIONS:
        raise SocialFail(400, "That reaction isn't available.")
    if on:
        conn.execute("INSERT OR IGNORE INTO reactions VALUES (?, ?, ?, ?, ?, ?, ?)", (*key, me, emoji, int(time.time())))
    else:
        conn.execute("DELETE FROM reactions WHERE sender=? AND target=? AND time=? AND hash=? AND user=? AND emoji=?",
                     (*key, me, emoji))
    tell(msg_audience(key[1], key[0]), me, "reaction",
         {"sender": key[0], "target": key[1], "time": key[2], "hash": key[3], "user": me, "emoji": emoji, "on": on})


def time_range(t_from, t_to):
    """Optional message-time window (ms) so apps only fetch what they show."""
    return " AND time >= ? AND time <= ?", (int(t_from or 0), int(t_to or 2**62))


def reactions_for(conn, me, conv, t_from=None, t_to=None):
    where, args = conv_filter(me, conv)
    rw, ra = time_range(t_from, t_to)
    rows = conn.execute(f"SELECT sender, target, time, hash, user, emoji FROM reactions WHERE {where}{rw}", (*args, *ra))
    return [dict(zip(("sender", "target", "time", "hash", "user", "emoji"), r)) for r in rows]


def edit(conn, me, key, text):
    text = str(text or "").replace("\r", " ").replace("\n", " ").strip()[:400]
    if not text:
        raise SocialFail(400, "The message can't be empty.")
    if key[0] != me:
        raise SocialFail(403, "You can only edit your own messages.")
    conn.execute("INSERT OR REPLACE INTO edits VALUES (?, ?, ?, ?, ?, ?)", (*key, text, int(time.time())))
    tell(msg_audience(key[1], key[0]), me, "edit",
         {"sender": key[0], "target": key[1], "time": key[2], "hash": key[3], "text": text})


def edits_for(conn, me, conv, t_from=None, t_to=None):
    where, args = conv_filter(me, conv)
    rw, ra = time_range(t_from, t_to)
    rows = conn.execute(f"SELECT sender, target, time, hash, text FROM edits WHERE {where}{rw}", (*args, *ra))
    return [dict(zip(("sender", "target", "time", "hash", "text"), r)) for r in rows]


MAX_PINS = 5


def pin(conn, me, room, key, text, on):
    if on:
        n = conn.execute("SELECT COUNT(*) FROM pins WHERE room = ?", (room,)).fetchone()[0]
        if n >= MAX_PINS:
            raise SocialFail(409, f"A room can have at most {MAX_PINS} pinned messages.")
        conn.execute("INSERT OR REPLACE INTO pins VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (room, key[0], key[2], key[3], str(text or "")[:400], me, int(time.time())))
    else:
        conn.execute("DELETE FROM pins WHERE room=? AND sender=? AND time=? AND hash=?", (room, key[0], key[2], key[3]))
    push_all("pins", {"room": room})


def pins_for(conn, room):
    rows = conn.execute("SELECT sender, time, hash, text, pinned_by FROM pins WHERE room = ? ORDER BY created", (room,))
    return [dict(zip(("sender", "time", "hash", "text", "pinnedBy"), r)) for r in rows]


# ---------- polls ----------

def create_poll(conn, me, room, question, options):
    question = " ".join(str(question or "").split())[:200]
    opts = [" ".join(str(o).split())[:80] for o in (options or []) if str(o).strip()][:8]
    if not question or len(opts) < 2:
        raise SocialFail(400, "A poll needs a question and at least 2 choices.")
    cur = conn.execute("INSERT INTO polls (room, author, question, options, created) VALUES (?, ?, ?, ?, ?)",
                       (room, me, question, json.dumps(opts), int(time.time())))
    return cur.lastrowid


def poll_state(conn, me, poll_id):
    row = conn.execute("SELECT id, room, author, question, options, created FROM polls WHERE id = ?", (poll_id,)).fetchone()
    if not row:
        raise SocialFail(404, "That poll isn't there any more.")
    opts = json.loads(row[4])
    counts = [0] * len(opts)
    mine = None
    voters = [[] for _ in opts]
    for user, opt in conn.execute("SELECT user, option FROM poll_votes WHERE poll = ?", (poll_id,)):
        if 0 <= opt < len(opts):
            counts[opt] += 1
            voters[opt].append(user)
        if user == me:
            mine = opt
    return {"id": row[0], "room": row[1], "author": row[2], "question": row[3], "options": opts,
            "counts": counts, "voters": voters, "mine": mine, "created": row[5]}


def vote(conn, me, poll_id, option):
    st = poll_state(conn, me, poll_id)
    if option is None:
        conn.execute("DELETE FROM poll_votes WHERE poll = ? AND user = ?", (poll_id, me))
    elif not (0 <= int(option) < len(st["options"])):
        raise SocialFail(400, "That choice isn't in the poll.")
    else:
        conn.execute("INSERT OR REPLACE INTO poll_votes VALUES (?, ?, ?)", (poll_id, me, int(option)))
    push_all("poll", {"id": poll_id})


# ---------- last seen ----------

def touch_last_seen(conn, user):
    conn.execute("INSERT OR REPLACE INTO last_seen VALUES (?, ?)", (user, int(time.time())))


def last_seen(conn, users):
    users = [u for u in users][:200]
    if not users:
        return {}
    q = ",".join("?" * len(users))
    online = set(_listeners)
    out = {u: t for u, t in conn.execute(f"SELECT user, time FROM last_seen WHERE user IN ({q})", users)}
    return {u: ("now" if u in online else out.get(u)) for u in users}


# ---------- reminders ----------

MAX_REMINDER = 30 * 24 * 3600


def add_reminder(conn, me, text, minutes):
    text = " ".join(str(text or "").split())[:200]
    try:
        secs = int(float(minutes) * 60)
    except (TypeError, ValueError):
        raise SocialFail(400, "When should I remind you?")
    if not text or not (60 <= secs <= MAX_REMINDER):
        raise SocialFail(400, "Reminders can be set from 1 minute to 30 days ahead.")
    due = int(time.time()) + secs
    cur = conn.execute("INSERT INTO reminders (user, text, due) VALUES (?, ?, ?)", (me, text, due))
    return {"id": cur.lastrowid, "text": text, "due": due}


def due_reminders(conn, user=None):
    """Reminders that are due and not yet delivered (for one user, or all)."""
    now = int(time.time())
    if user:
        rows = conn.execute("SELECT id, user, text, due FROM reminders WHERE user = ? AND due <= ? AND delivered = 0",
                            (user, now))
    else:
        rows = conn.execute("SELECT id, user, text, due FROM reminders WHERE due <= ? AND delivered = 0", (now,))
    return [dict(zip(("id", "user", "text", "due"), r)) for r in rows]


def mark_delivered(conn, ids):
    for i in ids:
        conn.execute("UPDATE reminders SET delivered = 1 WHERE id = ?", (i,))


def pending_reminders(conn, me):
    rows = conn.execute("SELECT id, text, due FROM reminders WHERE user = ? AND delivered = 0 ORDER BY due", (me,))
    return [dict(zip(("id", "text", "due"), r)) for r in rows]


# ---------- name colors ----------

# Readable on the white chat background; the app shows the same palette.
NAME_COLORS = {"#c0392b", "#d35400", "#b7950b", "#27ae60", "#16a085", "#2980b9",
               "#1f3a93", "#8e44ad", "#c2185b", "#6d4c41", "#546e7a", "#000000"}


def set_name_color(conn, me, color):
    if color is None or color == "":
        conn.execute("DELETE FROM name_colors WHERE user = ?", (me,))
        color = None
    else:
        color = str(color).lower()
        if color not in NAME_COLORS:
            raise SocialFail(400, "That color isn't available.")
        conn.execute("INSERT OR REPLACE INTO name_colors VALUES (?, ?)", (me, color))
    push_all("namecolor", {"user": me, "color": color})


def name_colors(conn, users):
    users = list(users)[:300]
    if not users:
        return {}
    q = ",".join("?" * len(users))
    return {u: c for u, c in conn.execute(f"SELECT user, color FROM name_colors WHERE user IN ({q})", users)}


# ---------- disappearing messages ----------

MAX_EXPIRE = 7 * 24 * 3600


def set_expiry(conn, me, key, after_secs):
    after_secs = int(after_secs)
    if key[0] != me or not (10 <= after_secs <= MAX_EXPIRE):
        raise SocialFail(400, "Bad request.")
    due = int(key[2] // 1000) + after_secs
    conn.execute("INSERT OR REPLACE INTO expiring VALUES (?, ?, ?, ?, ?)", (*key, due))
    tell(msg_audience(key[1], key[0]), me, "expire",
         {"sender": key[0], "target": key[1], "time": key[2], "hash": key[3], "due": due})


def expiries_for(conn, me, conv, t_from=None, t_to=None):
    where, args = conv_filter(me, conv)
    rw, ra = time_range(t_from, t_to)
    rows = conn.execute(f"SELECT sender, target, time, hash, due FROM expiring WHERE {where}{rw}", (*args, *ra))
    return [dict(zip(("sender", "target", "time", "hash", "due"), r)) for r in rows]


def expire_due(conn):
    """Turn due disappearing messages into deletions and tell people."""
    now = int(time.time())
    rows = list(conn.execute("SELECT sender, target, time, hash FROM expiring WHERE due <= ?", (now,)))
    for sender, target, t, h in rows:
        redact(conn, sender, target, t, h)
        conn.execute("DELETE FROM expiring WHERE sender=? AND target=? AND time=? AND hash=?", (sender, target, t, h))
        tell(msg_audience(target, sender), sender, "redact", {"sender": sender, "target": target, "time": t, "hash": h})
    return len(rows)


# ---------- saved messages ----------

def save_message(conn, me, key, conv, text, on):
    if on:
        conn.execute("INSERT OR REPLACE INTO saved VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     (me, *key, str(conv)[:60], str(text or "")[:500], int(time.time())))
    else:
        conn.execute("DELETE FROM saved WHERE user=? AND sender=? AND target=? AND time=? AND hash=?", (me, *key))
    push(me, "saved-changed", {})


def saved_list(conn, me):
    rows = conn.execute("SELECT sender, target, time, hash, conv, text FROM saved WHERE user = ? ORDER BY created DESC LIMIT 300", (me,))
    return [dict(zip(("sender", "target", "time", "hash", "conv", "text"), r)) for r in rows]


# ---------- room activity (trending) ----------

def note_activity(conn, room):
    day = time.strftime("%Y-%m-%d", time.gmtime())
    conn.execute("INSERT INTO room_activity VALUES (?, ?, 1) ON CONFLICT(room, day) DO UPDATE SET msgs = msgs + 1",
                 (room, day))


def trending(conn, limit=8):
    day = time.strftime("%Y-%m-%d", time.gmtime())
    rows = conn.execute("SELECT room, msgs FROM room_activity WHERE day = ? ORDER BY msgs DESC LIMIT ?", (day, limit))
    return [{"room": r, "msgs": n} for r, n in rows]


# ---------- IMVironments (themes for private chats) ----------

IMV_THEMES = {"none", "beach", "night", "rain", "love", "space", "forest", "snow", "sunset"}


def pair_key(a, b):
    return "|".join(sorted([a, b]))


def set_imv(conn, me, other, theme):
    if theme not in IMV_THEMES:
        raise SocialFail(400, "That theme isn't available.")
    pk = pair_key(me, other)
    if theme == "none":
        conn.execute("DELETE FROM imv WHERE pair = ?", (pk,))
    else:
        conn.execute("INSERT OR REPLACE INTO imv VALUES (?, ?, ?)", (pk, theme, me))
    for u in (me, other):
        push(u, "imv", {"a": me, "b": other, "theme": theme, "by": me})


def get_imv(conn, me, other):
    row = conn.execute("SELECT theme, by_user FROM imv WHERE pair = ?", (pair_key(me, other),)).fetchone()
    return {"theme": row[0] if row else "none", "by": row[1] if row else None}


# ---------- timezones ----------

def tz_distance(a, b):
    """Minutes between two UTC offsets on the 24h clock (UTC+12 and UTC-11 are 1h apart)."""
    d = abs(a - b) % 1440
    return min(d, 1440 - d)


def set_tz(conn, me, tz, offset):
    tz = str(tz or "")[:64]
    offset = int(offset)
    if not -720 <= offset <= 840:
        raise SocialFail(400, "Bad timezone.")
    conn.execute("INSERT OR REPLACE INTO user_tz VALUES (?, ?, ?, ?)", (me, tz, offset, int(time.time())))


def user_tz(conn, users):
    users = list(users)[:300]
    if not users:
        return {}
    q = ",".join("?" * len(users))
    out = {u: {"tz": t, "offset": o} for u, t, o in
           conn.execute(f"SELECT user, tz, offset FROM user_tz WHERE user IN ({q})", users)}
    for u, a, b in conn.execute(f"SELECT user, start, end FROM user_active WHERE user IN ({q})", users):
        if u in out:
            out[u]["active"] = [a, b]
    return out


def set_active(conn, me, start, end):
    """Active hours in the person's own local time (minutes after midnight);
    None clears them (= always fine to message)."""
    if start is None or end is None:
        conn.execute("DELETE FROM user_active WHERE user = ?", (me,))
    else:
        start, end = int(start), int(end)
        if not (0 <= start < 1440 and 0 <= end < 1440) or start == end:
            raise SocialFail(400, "Pick a start and an end time.")
        conn.execute("INSERT OR REPLACE INTO user_active VALUES (?, ?, ?)", (me, start, end))
    push_all("active-changed", {"user": me})


def note_room_tz(conn, room, user):
    row = conn.execute("SELECT offset FROM user_tz WHERE user = ?", (user,)).fetchone()
    if not row:
        return
    day = time.strftime("%Y-%m-%d", time.gmtime())
    conn.execute("INSERT INTO room_tz VALUES (?, ?, ?, 1) ON CONFLICT(room, day, offset) DO UPDATE SET msgs = msgs + 1",
                 (room, day, row[0]))


def room_tz(conn, rooms):
    """A room's typical UTC offset: the message-weighted median of the
    senders' offsets over the last 7 days (None when nobody reported)."""
    since = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 7 * 86400))
    out = {}
    for room in list(rooms)[:200]:
        rows = sorted(conn.execute("SELECT offset, SUM(msgs) FROM room_tz WHERE room = ? AND day >= ? GROUP BY offset",
                                   (room, since)))
        total = sum(n for _, n in rows)
        if not total:
            out[room] = None
            continue
        acc = 0
        for off, n in rows:
            acc += n
            if acc * 2 >= total:
                out[room] = off
                break
    return out


# ---------- scheduled messages ----------

MAX_SCHEDULED = 50
MAX_SCHEDULE_AHEAD = 30 * 24 * 3600


def schedule(conn, me, target, text, due):
    text = str(text or "").replace("\r", " ").replace("\n", " ").strip()[:400]
    due = int(due)
    now = int(time.time())
    if not text:
        raise SocialFail(400, "The message is empty.")
    if not (now + 30 <= due <= now + MAX_SCHEDULE_AHEAD):
        raise SocialFail(400, "Pick a time between 1 minute and 30 days from now.")
    n = conn.execute("SELECT COUNT(*) FROM scheduled WHERE user = ? AND sent = 0", (me,)).fetchone()[0]
    if n >= MAX_SCHEDULED:
        raise SocialFail(409, f"You already have {MAX_SCHEDULED} scheduled messages.")
    cur = conn.execute("INSERT INTO scheduled (user, target, text, due) VALUES (?, ?, ?, ?)", (me, target, text, due))
    push(me, "scheduled-changed", {})
    return {"id": cur.lastrowid, "target": target, "text": text, "due": due}


def scheduled_for(conn, me):
    rows = conn.execute("SELECT id, target, text, due FROM scheduled WHERE user = ? AND sent = 0 ORDER BY due", (me,))
    return [dict(zip(("id", "target", "text", "due"), r)) for r in rows]


def cancel_scheduled(conn, me, sid):
    conn.execute("DELETE FROM scheduled WHERE id = ? AND user = ? AND sent = 0", (int(sid), me))
    push(me, "scheduled-changed", {})


def due_scheduled(conn):
    now = int(time.time())
    rows = conn.execute("SELECT id, user, target, text FROM scheduled WHERE sent = 0 AND due <= ?", (now,))
    return [dict(zip(("id", "user", "target", "text"), r)) for r in rows]


def mark_scheduled_sent(conn, sid, user):
    conn.execute("UPDATE scheduled SET sent = 1 WHERE id = ?", (sid,))
    push(user, "scheduled-changed", {})
