#!/usr/bin/env python3
"""The IRC behaviour the a09f app relies on, checked against the real stack
(soju -> solanum + atheme). Uses alice and bob (both linked to NickServ);
the test room is registered and dropped again.

- friends-only: user mode +g + ACCEPT (716/718)
- STATUS lines in #a09f-presence reach others live
- moderation: $a: account extbans (mute +q, ban +b), KICK, KNOCK (710)
- ChanServ: REGISTER, FLAGS AOP, ENTRYMSG on join, MLOCK with key/limit
- history: CHATHISTORY BEFORE, soju SEARCH
- send-on-behalf: sojuctl network quote lands in both histories"""

import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from a09f import Check, Irc, DEMO_PASSWORD, drop_room  # noqa: E402

check = Check("IRC features used by the app")
room = "#zz-test-irc"
caps = ("server-time", "away-notify", "message-tags", "batch", "draft/chathistory", "soju.im/search")

drop_room("alice", room)          # leftovers from an interrupted run
a = Irc("alice", caps=caps)
b = Irc("bob", caps=caps)
if not (a.welcome and b.welcome):
    sys.exit("could not sign in as alice/bob through soju — is the stack up?")
try:
    # ChanServ REGISTER needs a services login; the bouncer upstream session
    # is only identified while a client sends NickServ IDENTIFY (the app does
    # this on connect — do the same here so the test doesn't depend on a
    # leftover identified session from an earlier run).
    for c, u in ((a, "alice"), (b, "bob")):
        rep = c.service("NickServ", f"IDENTIFY {u} {DEMO_PASSWORD}", 4)
        check(f"NickServ IDENTIFY {u}", any("logged in" in r.lower() or "identified" in r.lower() for r in rep), rep)

    # presence room (invisible / pre-away is covered by tests/e2e)
    for c in (a, b):
        c.send("JOIN #a09f-presence")
    a.read(1); b.read(1)
    a.send("PRIVMSG #a09f-presence :STATUS busy")
    check("STATUS line reaches others live", b.wait(r":alice!\S+ PRIVMSG #a09f-presence :?STATUS busy", 5))
    a.send("PRIVMSG #a09f-presence :STATUS available")

    # friends-only (+g)
    a.send("ACCEPT -bob"); a.send("MODE alice +g"); a.read(1)     # bob may be on the list from the app
    b.send("PRIVMSG alice :blocked?")
    check("+g: stranger gets 716", b.wait(r" 716 bob alice ", 5))
    check("+g: we get told once (718)", a.wait(r" 718 alice bob ", 5))
    a.send("ACCEPT bob"); a.read(0.5)
    b.send("PRIVMSG alice :allowed now")
    check("+g: ACCEPTed friend gets through", a.wait(r"PRIVMSG alice :?allowed now", 5))
    a.send("ACCEPT -bob"); a.send("MODE alice -g"); a.read(0.5)

    # room: register, moderation
    a.send(f"JOIN {room}")
    check("alice creates the room as op", a.wait(rf" 353 .* {room} :?@alice", 5))
    reply = a.service("ChanServ", f"REGISTER {room}", 3)
    check("ChanServ REGISTER", any("is now registered to" in r for r in reply), reply)
    b.send(f"JOIN {room}"); b.read(1)
    a.send(f"MODE {room} +qq $a:bob bob!*@*"); a.read(1)
    b.send(f"PRIVMSG {room} :can you hear me")
    check("mute by account ($a:) blocks talking (404)", b.wait(r" 404 ", 5))
    a.send(f"MODE {room} -qq $a:bob bob!*@*"); a.read(1)
    reply = a.service("ChanServ", f"FLAGS {room} bob AOP", 3)
    check("ChanServ FLAGS AOP", any("were set on" in r for r in reply), reply)
    a.service("ChanServ", f"FLAGS {room} bob -*", 2)
    reply = a.service("ChanServ", f"SET {room} ENTRYMSG Welcome, be nice!", 3)
    b.send(f"PART {room}"); b.read(0.5); b.send(f"JOIN {room}")
    check("ENTRYMSG shown on join", b.wait(rf"NOTICE bob :\[{room}\] Welcome, be nice!", 6))
    reply = a.service("ChanServ", f"SET {room} MLOCK +ntikl sekret 12", 3)
    a.send(f"MODE {room}")
    check("MLOCK sets key + limit (owner)", a.wait(rf" 324 alice {room} \+\S*k\S* .*sekret|12", 6), reply)
    a.service("ChanServ", f"SET {room} MLOCK +nti", 3)
    a.send(f"MODE {room} -k sekret"); a.send(f"MODE {room} -l"); a.read(1)
    a.send(f"MODE {room} +bb $a:bob bob!*@*"); a.send(f"KICK {room} bob :test"); a.read(1)
    b.send(f"JOIN {room}")
    check("ban by account keeps them out (474)", b.wait(r" 474 ", 5))
    a.send(f"MODE {room} -bb $a:bob bob!*@*"); a.read(1)
    b.send(f"KNOCK {room} :let me in")
    answer = b.wait(r" 71[12] ", 10) or ""
    if " 712 " in answer:          # solanum knock_delay: bob knocked recently
        check.skip("KNOCK reaches the op (710)", "rate-limited by knock_delay — run again in ~5 minutes")
    else:
        check("KNOCK on a private room reaches the op (710)", a.wait(rf" 710 {room} {room} bob!", 6), answer)
    a.send(f"INVITE bob {room}"); a.read(0.5)
    b.send(f"JOIN {room}")
    check("invited user can join a private room", b.wait(rf":bob!\S+ JOIN :?{room}", 6))

    # history
    for i in range(3):
        a.send(f"PRIVMSG {room} :history probe {i}")
    b.wait(r"history probe 2", 15)          # soju paces bursts: wait until all are stored
    a.read(1)
    a.send(f"CHATHISTORY BEFORE {room} timestamp={time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(time.time() + 60))}.000Z 2")
    hist = [l for l in a.read(3) if "history probe" in l]
    check("CHATHISTORY BEFORE pages history", len(hist) == 2, hist)
    a.send(f"SEARCH in={room};text=history\\sprobe\\s1;limit=5")
    found = [l for l in a.read(3) if "history probe 1" in l]
    check("soju SEARCH finds a message", len(found) >= 1)

    # send on behalf (scheduled messages)
    subprocess.run(["docker", "exec", "soju", "/sojuctl", "-config", "/soju-config", "user", "run", "alice",
                    "network", "quote", "solanum", "PRIVMSG bob :quoted by sojuctl"], capture_output=True)
    check("sojuctl network quote delivers as alice", b.wait(r":alice!\S+ PRIVMSG bob :?quoted by sojuctl", 6))
finally:
    for c in (a, b):
        c.send(f"PART {room}"); c.read(0.3); c.close()
    drop_room("alice", room)

check.done()
