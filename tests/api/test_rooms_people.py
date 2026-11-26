#!/usr/bin/env python3
"""Rooms & people: events with RSVP and the 15-minute heads-up, category &
language, trending + room timezone, friend suggestions, room read markers
("Seen by"), private notes, timezones & active hours, invite page.
Uses kate, leo and mia; cleans up after itself."""

import os
import sys
import threading
import time
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from a09f import API, Api, Check, sql, sse, wait_until  # noqa: E402

check = Check("rooms & people: events, categories, trending, suggestions, seen-by, notes, timezones")
room = "#zz-test-rooms"
k, l, m = Api("kate"), Api("leo"), Api("mia")
ev, stop = [], threading.Event()
sse(k.token, ev, stop)

try:
    start = int(time.time()) + 600
    eid = k.post("/event/create", {"room": room, "title": "Quiz night", "start": start})["id"]
    l.post("/event/rsvp", {"id": eid, "status": "maybe"})
    st = l.get(f"/event?id={eid}")
    check("event: RSVPs counted", st["people"]["going"] == ["kate"] and st["people"]["maybe"] == ["leo"], st)
    check("event: past times refused", not k.post("/event/create", {"room": room, "title": "x", "start": 5}).get("ok"))
    check("event: only the creator can cancel", not l.post("/event/delete", {"id": eid}).get("ok"))
    check("event: heads-up 15 min before (going/maybe)",
          wait_until(lambda: [d for e, d in ev if e == "event-soon" and d["id"] == eid], 20))

    k.post("/roominfo", {"room": room, "category": "games", "lang": "id"})
    check("room category & language", k.get(f"/roominfo?rooms=%23{room[1:]}")["info"].get(room) == {"category": "games", "lang": "id"})
    check("unknown category refused", not k.post("/roominfo", {"room": room, "category": "xx", "lang": "id"}).get("ok"))

    for who, tz in ((k, 420), (l, 420), (m, -300)):
        who.post("/tz", {"tz": "Test/Zone", "offset": tz})
    for _ in range(3):
        k.post("/activity", {"room": room})
    m.post("/activity", {"room": room})
    check("trending counts today's messages", any(t["room"] == room and t["msgs"] == 4 for t in k.get("/trending")["trending"]))
    check("room timezone = where its senders are", k.get(f"/roomtz?rooms=%23{room[1:]}")["tz"][room] == 420)
    check("timezone offsets validated", not k.post("/tz", {"tz": "x", "offset": 9999}).get("ok"))

    k.post("/active", {"start": 480, "end": 1320})
    check("active hours returned with the timezone", k.get("/tz?users=kate")["tz"]["kate"].get("active") == [480, 1320])

    k.post("/friends/request", {"to": "leo"}); l.post("/friends/respond", {"from": "kate", "accept": True})
    l.post("/friends/request", {"to": "mia"}); m.post("/friends/respond", {"from": "leo", "accept": True})
    sugg = k.get("/suggestions")["suggestions"]
    check("suggestions: friend of a friend", any(s["nick"] == "mia" and "friends with leo" in s["reasons"] for s in sugg), sugg)

    l.post("/roomread", {"room": room, "time": 1795000000000})
    check("room read markers (Seen by)", k.get(f"/roomreads?room=%23{room[1:]}")["reads"].get("leo") == 1795000000000)

    k.post("/note", {"about": "leo", "text": "met at the seminar"})
    check("private note stored", k.get("/notes")["notes"].get("leo") == "met at the seminar")
    check("…and private", not l.get("/notes")["notes"])

    with urllib.request.urlopen(f"{API}/join/lobby") as r:
        page = r.read().decode()
    check("invite page links to a09f://join/<room>", "a09f://join/lobby" in page)
    try:
        urllib.request.urlopen(f"{API}/join/%3Cscript%3E")
        check("invite page refuses odd names", False)
    except urllib.error.HTTPError as e:
        check("invite page refuses odd names", e.code == 404)
finally:
    stop.set()
    for a, b in (("kate", "leo"), ("leo", "mia")):
        Api(a).post("/friends/remove", {"nick": b})
    sql(f"DELETE FROM events WHERE room='{room}'; DELETE FROM rsvps; DELETE FROM room_info WHERE room='{room}'; "
        f"DELETE FROM room_activity WHERE room='{room}'; DELETE FROM room_tz WHERE room='{room}'; "
        f"DELETE FROM user_rooms WHERE room='{room}'; DELETE FROM room_reads WHERE room='{room}'; "
        "DELETE FROM notes WHERE owner='kate'; DELETE FROM user_active WHERE uname='kate'; "
        "DELETE FROM user_tz WHERE uname IN ('kate','leo','mia');")

check.done()
