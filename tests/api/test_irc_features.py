#!/usr/bin/env python3
"""The IRC behaviour the a09f app relies on, checked against the real stack
(Ergo + the account service). Uses alice, bob and charlie; the test room is
registered and unregistered again.

- STATUS lines in #a09f-presence reach others live
- always-on: a message to someone with no device connected is kept for them
- friends-only: the account service answers /canpm for the sender's app
- moderation: mute (+b m:<id>!*@*), ban (+b <id>!*@*), KICK
- ChanServ: REGISTER, AMODE +o, modes kept by a registered room, UNREGISTER
- "ask to join" (/knock) reaches the room's apps as a live event
- history: CHATHISTORY BEFORE, message search through the account service"""

import os
import sys
import threading
import time
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from a09f import Api, Check, Irc, drop_room, sse, wait_until  # noqa: E402

check = Check("IRC features used by the app")
room = "#zz-test-irc"
caps = ("server-time", "away-notify", "message-tags", "batch", "draft/chathistory")

drop_room("alice", room)          # leftovers from an interrupted run
a = Irc("alice", caps=caps)
b = Irc("bob", caps=caps)
if not (a.welcome and b.welcome):
    sys.exit("could not sign in as alice/bob — is the stack up?")
stop = threading.Event()
try:
    # presence room (invisible / pre-away is covered by tests/e2e)
    for c in (a, b):
        c.send("JOIN #a09f-presence")
    a.read(1); b.read(1)
    a.send("PRIVMSG #a09f-presence :STATUS busy")
    check("STATUS line reaches others live", b.wait(r":alice!\S+ PRIVMSG #a09f-presence :?STATUS busy", 5))
    a.send("PRIVMSG #a09f-presence :STATUS available")

    # always-on: charlie has no device connected, the message waits for him
    marker = f"kept for later {int(time.time())}"
    a.send(f"PRIVMSG charlie :{marker}")
    check("message to an offline account is accepted (no 401)", not a.wait(r" 401 ", 2))
    c3 = Irc("charlie", caps=caps)
    c3.send("CHATHISTORY LATEST alice * 10")
    check("…and it's in their history when they sign in", c3.wait(marker, 6))
    c3.close()

    # friends-only: checked by the sender's app with the account service
    api_a, api_b = Api("alice"), Api("bob")
    api_a.post("/friends/remove", {"nick": "bob"})
    api_a.post("/prefs", {"friendsOnly": True})
    check("/canpm: stranger may not message a friends-only person",
          api_b.get("/canpm?to=alice").get("allowed") is False)
    api_a.post("/prefs", {"friendsOnly": False})
    check("/canpm: allowed again when it's off", api_b.get("/canpm?to=alice").get("allowed") is True)

    # room: register, moderation
    a.send(f"JOIN {room}")
    check("alice creates the room as op", a.wait(rf" 353 .* {room} :?[~@]alice", 5))
    reply = a.service("ChanServ", f"REGISTER {room}", 3)
    check("ChanServ REGISTER", any("successfully registered" in r for r in reply), reply)
    b.send(f"JOIN {room}"); b.read(1)
    a.send(f"MODE {room} +b m:bob!*@*"); a.read(1)
    b.send(f"PRIVMSG {room} :can you hear me")
    check("mute (+b m:) blocks talking (404)", b.wait(r" 404 ", 5))
    a.send(f"MODE {room} -b m:bob!*@*"); a.read(1)
    reply = a.service("ChanServ", f"AMODE {room} +o bob", 3)
    check("ChanServ AMODE +o", any("successfully set persistent mode" in r.lower() for r in reply), reply)
    reply = a.service("ChanServ", f"AMODE {room}", 3)
    check("AMODE list shows the moderator", any("Account bob receives mode +o" in r for r in reply), reply)
    a.service("ChanServ", f"AMODE {room} -o bob", 2)

    # a registered room keeps its modes, even while empty
    a.send(f"MODE {room} +kl sekret 12"); a.read(1)
    b.send(f"PART {room}"); a.send(f"PART {room}"); a.read(1); b.read(0.5)
    a.send(f"JOIN {room} sekret")
    a.wait(rf" 366 alice {room} ", 5)
    a.send(f"MODE {room}")
    check("registered room keeps key + limit", a.wait(rf" 324 alice {room} \+\S*k\S*l?\S* .*sekret", 6))
    a.send(f"MODE {room} -kl sekret"); a.send(f"MODE {room} +i"); a.read(1)

    # ban + kick
    b.send(f"JOIN {room}")
    check("private room: uninvited user gets 473", b.wait(rf" 473 bob {room} ", 5))
    a.send(f"MODE {room} -i"); a.read(0.5)
    b.send(f"JOIN {room}"); b.read(1)
    a.send(f"MODE {room} +b bob!*@*"); a.send(f"KICK {room} bob :test"); a.read(1)
    b.send(f"JOIN {room}")
    check("ban keeps them out (474)", b.wait(r" 474 ", 5))
    a.send(f"MODE {room} -b bob!*@*"); a.send(f"MODE {room} +i"); a.read(1)

    # ask to join: a live event for the room's apps
    events = []
    sse(api_a.token, events, stop)
    time.sleep(1)
    api_b.post("/knock", {"room": room})
    check("/knock reaches alice's app", wait_until(lambda: any(e[0] == "knock" and e[1].get("from") == "bob"
                                                               for e in events), 6))
    a.send(f"INVITE bob {room}"); a.read(0.5)
    b.send(f"JOIN {room}")
    check("invited user can join a private room", b.wait(rf":bob!\S+ JOIN :?{room}", 6))
    a.send(f"MODE {room} -i")

    # history
    tag = int(time.time())
    for i in range(3):
        a.send(f"PRIVMSG {room} :history probe {tag} {i}")
    b.wait(rf"history probe {tag} 2", 10)
    a.read(1)
    a.send(f"CHATHISTORY BEFORE {room} timestamp={time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(time.time() + 60))}.000Z 2")
    hist = [l for l in a.read(3) if f"history probe {tag}" in l]
    check("CHATHISTORY BEFORE pages history", len(hist) == 2, hist)
    q = urllib.parse.quote(f"probe {tag} 1")
    found = api_a.get(f"/search?q={q}&in={urllib.parse.quote(room)}").get("lines", [])
    check("search finds a room message", any(f"history probe {tag} 1" in l for l in found), found)
    found = api_a.get(f"/search?q={urllib.parse.quote(marker)}").get("lines", [])
    check("search (everywhere) finds a private message", any(marker in l for l in found), found)
    r = Api("charlie").get(f"/search?q=probe&in={urllib.parse.quote(room)}")
    check("search refuses rooms you're not in", r.get("ok") is False and "rooms you're in" in r.get("error", ""), r)
finally:
    stop.set()
    for c in (a, b):
        c.send(f"PART {room}"); c.read(0.3); c.close()
    drop_room("alice", room)

check.done()
