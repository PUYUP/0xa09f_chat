"""Peer for messaging.js: bob."""
import time

from a09f import fnv
from peer import Peer

p = Peer("bob")


@p.on("react")
def _(args):
    t, text = args.split(" ", 1)
    p.api.post("/react", {"sender": "alice", "target": "bob", "time": int(t), "hash": fnv(text), "emoji": "👍", "on": True})
    p.reply("reacted")


@p.on("read")
def _(args):
    time.sleep(1)
    # No reply here: a reply would become the last message, and "Seen" only
    # shows under *my* last message.
    p.api.post("/read", {"to": "alice", "time": int(time.time() * 1000)})


@p.on("bye")
def _(args):
    pass


p.run()
