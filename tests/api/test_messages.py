#!/usr/bin/env python3
"""Message extras keyed by (sender, target, server time, text hash): deletes,
reactions, edits, pins, polls, disappearing messages, saved messages, and
send-later (delivered by soju on the sender's behalf). Uses henry and irene.

Real messages are sent over IRC so the server times are the real ones —
the same times both apps see."""

import os
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from snailog import Api, Check, Irc, fnv, server_ms, sql, sse, wait_until  # noqa: E402

check = Check("message extras: delete, react, edit, pin, poll, expire, saved, send later")
A, B = "henry", "irene"
a, b = Api(A), Api(B)
ia, ib = Irc(A), Irc(B)
events, stop = [], threading.Event()
sse(b.token, events, stop)


def say(text, target=B):
    """Send as henry; return the message key as irene's app computes it."""
    ia.send(f"PRIVMSG {target} :{text}")
    line = ib.wait(rf"PRIVMSG {target} :?{text}$", 8)
    return {"sender": A, "target": target.lower(), "time": server_ms(line), "hash": fnv(text)} if line else None


try:
    k1 = say("first message")
    check("message has the same server time on both sides", k1 and k1["time"])
    a.post("/redact", {"target": k1["target"], "time": k1["time"], "hash": k1["hash"]})
    check("delete: irene gets a live redact", wait_until(lambda: [d for e, d in events if e == "redact" and d["time"] == k1["time"]], 6))
    check("delete: listed for later sign-ins", any(r["time"] == k1["time"] for r in b.get("/redactions?since=0")["redactions"]))

    k2 = say("react to me")
    b.post("/react", {**k2, "emoji": "👍", "on": True})
    r = b.post("/react", {**k2, "emoji": "💩", "on": True})
    check("react: emoji outside the set refused", not r.get("ok"), r)
    meta = a.get(f"/msgmeta?conv={B}")
    check("react: stored and visible to the sender", any(x["emoji"] == "👍" and x["user"] == B for x in meta["reactions"]))
    a.post("/edit", {"target": k2["target"], "time": k2["time"], "hash": k2["hash"], "text": "react to me (edited)"})
    check("edit: irene gets it live", wait_until(lambda: [d for e, d in events if e == "edit"], 6))
    m2 = b.get(f"/msgmeta?conv={A}&from={k2['time']}&to={k2['time']}")
    check("msgmeta time range returns just that message's data", len(m2["edits"]) == 1 and len(m2["reactions"]) == 1, m2)
    m3 = b.get(f"/msgmeta?conv={A}&from={k2['time'] + 1}")
    check("…and nothing outside the range", not m3["edits"] and not m3["reactions"], m3)

    b.post("/save", {**k2, "conv": A, "text": "react to me", "on": True})
    check("saved: listed", any(s["time"] == k2["time"] for s in b.get("/saved")["saved"]))
    b.post("/save", {**k2, "on": False})
    check("saved: removed", not b.get("/saved")["saved"])

    k3 = say("this will vanish")
    a.post("/expire", {"target": k3["target"], "time": k3["time"], "hash": k3["hash"], "after": 10})
    check("expire: irene sees the timer", wait_until(lambda: [d for e, d in events if e == "expire"], 6))
    check("expire: deleted for everyone after ~10s",
          wait_until(lambda: [d for e, d in events if e == "redact" and d["time"] == k3["time"]], 30))

    room = "#zz-test-msgs"
    ia.send(f"JOIN {room}"); ib.send(f"JOIN {room}"); ia.read(1); ib.read(1)
    pid = a.post("/poll/create", {"room": room, "question": "Lunch?", "options": ["Bakso", "Sate"]})["id"]
    b.post("/poll/vote", {"id": pid, "option": 1})
    st = a.get(f"/poll?id={pid}")
    check("poll: votes counted", st["counts"] == [0, 1] and st["voters"][1] == [B], st)
    check("poll: needs 2 choices", not a.post("/poll/create", {"room": room, "question": "x", "options": ["only"]}).get("ok"))
    kp = say("pin me", room)
    a.post("/pin", {"room": room, **kp, "text": "pin me", "on": True})
    check("pin: shown for the room", any(p["text"] == "pin me" for p in b.get(f"/msgmeta?conv=%23{room[1:]}")["pins"]))

    due = int(time.time()) + 35
    r = a.post("/schedule", {"target": B, "text": "sent later by soju", "due": due})
    check("send later: scheduled", r.get("ok"), r)
    check("send later: target must be an ID or a room", not a.post("/schedule", {"target": "x :y", "text": "z", "due": due}).get("ok"))
    check("send later: delivered on time over IRC", ib.wait(r"PRIVMSG irene :sent later by soju", 60))
    check("send later: no longer pending", not a.get("/scheduled")["scheduled"])
finally:
    stop.set()
    for c in (ia, ib):
        c.send("PART #zz-test-msgs"); c.close()
    sql("DELETE FROM redactions WHERE sender='henry'; DELETE FROM reactions WHERE sender='henry'; "
        "DELETE FROM edits WHERE sender='henry'; DELETE FROM pins WHERE room='#zz-test-msgs'; "
        "DELETE FROM poll_votes WHERE poll IN (SELECT id FROM polls WHERE room='#zz-test-msgs'); "
        "DELETE FROM polls WHERE room='#zz-test-msgs'; DELETE FROM expiring WHERE sender='henry'; "
        "DELETE FROM scheduled WHERE uname='henry'; DELETE FROM saved WHERE uname='irene';")

check.done()
