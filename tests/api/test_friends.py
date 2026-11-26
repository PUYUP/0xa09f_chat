#!/usr/bin/env python3
"""Friends & privacy through the account service, with the live events
(SSE) each step sends. Uses demo accounts frank and grace and leaves them
as they were."""

import os
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from a09f import Api, Check, sse, wait_until  # noqa: E402

check = Check("friends, groups, privacy, typing, devices")
A, B = "frank", "grace"
a, b = Api(A), Api(B)
a.post("/friends/remove", {"nick": B})
b.post("/friends/remove", {"nick": A})
ev_a, ev_b, stop = [], [], threading.Event()
sse(a.token, ev_a, stop)
sse(b.token, ev_b, stop)
got = lambda sink, name: wait_until(lambda: [d for e, d in sink if e == name], 6)

try:
    r = a.post("/friends/request", {"to": "nosuchuserzz"})
    check("request to an unknown ID refused", not r.get("ok"), r)
    r = a.post("/friends/request", {"to": B, "group": "Work", "msg": "hi!"})
    check("request sent", r.get("result") == "requested", r)
    check("grace gets a live friend-request", got(ev_b, "friend-request"))
    check("grace sees it as incoming", any(i["from"] == A for i in b.get("/friends")["incoming"]))
    r = b.post("/friends/respond", {"from": A, "accept": True, "group": "Family"})
    check("accepted: friends on both sides", any(f["nick"] == A for f in r["friends"])
          and any(f["nick"] == B and f["group"] == "Work" for f in a.get("/friends")["friends"]))
    check("frank gets a live friend-accepted", got(ev_a, "friend-accepted"))

    a.post("/friends/move", {"nick": B, "group": "Office"})
    check("move to another group", any(f["group"] == "Office" for f in a.get("/friends")["friends"]))
    a.post("/friends/rename-group", {"from": "Office", "to": "Team"})
    check("rename a group", any(f["group"] == "Team" for f in a.get("/friends")["friends"]))

    a2 = Api(A, device="second device")
    ev_a2 = []
    sse(a2.token, ev_a2, stop)
    a.post("/friends/move", {"nick": B, "group": "Friends"})
    check("my other device gets friends-changed (with my sid)",
          wait_until(lambda: [d for e, d in ev_a2 if e == "friends-changed" and d.get("sid") == a.sid], 6))

    a.post("/typing", {"to": B, "active": True})
    check("typing reaches grace", wait_until(lambda: [d for e, d in ev_b if e == "typing" and d["from"] == A], 6))

    p = a.post("/prefs", {"ignore": ["Grace", "bad id!", A], "friendsOnly": True})
    check("prefs: ignore list cleaned (no self, no junk)", p.get("ignore") == [B], p)
    check("prefs: friendsOnly stored", a.get("/prefs").get("friendsOnly") is True)
    a.post("/prefs", {"ignore": [], "friendsOnly": False})

    r = a.get("/users/search?q=ra")
    check("search finds people by part of the ID", B in r.get("users", []), r)
    check("search needs 2 letters", not a.get("/users/search?q=r").get("ok"))

    devs = a.get("/sessions")["sessions"]
    check("devices list shows both sessions", sum(1 for d in devs if d["device"] in ("a09f tests", "second device")) >= 2)
    a.post("/session/revoke", {"sid": a2.sid})
    check("revoked device gets signed-out (only that one)",
          wait_until(lambda: [d for e, d in ev_a2 if e == "signed-out" and d.get("only") == a2.sid], 6))
    check("revoked token stops working", not a2.get("/friends").get("ok"))

    b.post("/friends/remove", {"nick": A})
    check("removing ends it on both sides", not any(f["nick"] == B for f in a.get("/friends")["friends"]))
    check("frank gets a live friend-removed", got(ev_a, "friend-removed"))
finally:
    stop.set()
    a.post("/friends/remove", {"nick": B})
    b.post("/friends/remove", {"nick": A})

check.done()
