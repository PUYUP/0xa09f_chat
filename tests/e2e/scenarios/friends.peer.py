"""Peer for friends.js: frank."""
from peer import Peer

p = Peer("frank")
p.api.post("/friends/remove", {"nick": "alice"})          # start as strangers
p.irc.send("JOIN #snailog-presence")


@p.on("request")
def _(args):
    p.api.post("/friends/request", {"to": "alice", "msg": "hi from the e2e test"})


@p.on("typing")
def _(args):
    p.api.post("/typing", {"to": "alice", "active": True})


@p.on("status-busy")
def _(args):
    p.irc.send("PRIVMSG #snailog-presence :STATUS busy")


@p.on("status-available")
def _(args):
    p.irc.send("PRIVMSG #snailog-presence :STATUS available")


@p.on("whois")
def _(args):
    p.irc.send("WHOIS alice")
    away = p.irc.wait(r" 301 frank alice | 318 frank alice ", 5) or ""
    p.reply("whois away" if " 301 " in away else "whois here")


@p.on("unfriend")
def _(args):
    p.api.post("/friends/remove", {"nick": "alice"})


@p.on("bye")
def _(args):
    p.api.post("/friends/remove", {"nick": "alice"})


p.run()
