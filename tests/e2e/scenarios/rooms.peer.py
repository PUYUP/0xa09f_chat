"""Peer for rooms.js: bob."""
import urllib.parse
import time

from peer import Peer

p = Peer("bob")


@p.on("join")
def _(room):
    p.irc.send(f"JOIN {room}")
    line = p.irc.wait(rf"(:bob!\S+ JOIN :?{room}| 47[1345] )", 8) or ""
    p.reply("joined" if "JOIN" in line else "join banned" if " 474 " in line else f"join failed {line[-40:]}")


@p.on("welcome?")
def _(room):
    # The welcome message is kept by the account service; a09f apps show it
    # when they join the room.
    text = p.api.get(f"/welcome?room={urllib.parse.quote(room.lower())}").get("text", "")
    p.reply("welcome yes" if "Hello from e2e" in text else "welcome no")


@p.on("say")
def _(room):
    p.irc.send(f"PRIVMSG {room} :can you hear me")
    blocked = p.irc.wait(r" 404 ", 4)
    p.reply("say blocked" if blocked else "say ok")


@p.on("roomread")
def _(room):
    time.sleep(1)
    p.api.post("/roomread", {"room": room.lower(), "time": int(time.time() * 1000)})
    p.reply("read")


@p.on("part")
def _(room):
    p.irc.send(f"PART {room}")


@p.on("bye")
def _(args):
    pass


p.run()
