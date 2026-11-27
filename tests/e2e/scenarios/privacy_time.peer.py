"""Peer for privacy_time.js: frank (a stranger to alice)."""
import time

from snailog import sql
from peer import Peer

# Commands come in through bob: messaging frank himself would put him on
# alice's ACCEPT list and defeat the "only friends" check.
p = Peer("frank", control="bob")
p.api.post("/friends/remove", {"nick": "alice"})


@p.on("pm")
def _(text):
    p.irc.send(f"PRIVMSG alice :{text}")


@p.on("pmcheck")
def _(args):
    p.irc.send("PRIVMSG alice :are you there?")
    got = p.irc.wait(r" 716 frank alice ", 4)
    p.reply("blocked" if got else "delivered")


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
