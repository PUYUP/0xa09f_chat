"""Peer for privacy_time.js: frank (a stranger to alice)."""
import time

from a09f import Irc, sql
from peer import Peer

# Commands come in through bob, so alice's app never writes to frank (that
# would let frank's answers through "only friends").
p = Peer("frank", control="bob")
p.api.post("/friends/remove", {"nick": "alice"})


@p.on("pm")
def _(text):
    p.irc.send(f"PRIVMSG alice :{text}")


@p.on("pmfrom")
def _(args):
    # A private message from someone alice never wrote to.
    who, text = args.split(" ", 1)
    c = Irc(who)
    c.send(f"PRIVMSG alice :{text}")
    c.read(1)
    c.close()
    p.reply("sent")


@p.on("friendsonly")
def _(arg):
    p.api.post("/prefs", {"friendsOnly": arg == "on"})
    p.reply(f"friendsonly {arg}")


@p.on("tz")
def _(offset):
    p.api.post("/tz", {"tz": "America/New_York", "offset": int(offset)})
    p.reply("tz set")


@p.on("active-off-now")
def _(args):
    # Active hours that don't include frank's current local time.
    now = time.gmtime(time.time() - 5 * 3600)
    minutes = now.tm_hour * 60 + now.tm_min
    start = (minutes + 120) % 1440
    p.api.post("/active", {"start": start, "end": (start + 60) % 1440})
    p.reply("active set")


@p.on("bye")
def _(args):
    p.api.post("/active", {"start": None, "end": None})
    sql("DELETE FROM user_tz WHERE uname='frank'; DELETE FROM scheduled WHERE uname='alice';")


p.run()
