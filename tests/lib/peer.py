"""The "other people" in an e2e scenario.

A scenario running in the app (signed in as alice) sends
    PRIVMSG <peer> :cmd:<name> [args]
and the peer script runs the matching handler, usually answering with
    PRIVMSG alice :re:<result>
which the scenario reads from its private chat with the peer.

    p = Peer("bob")
    @p.on("whois")
    def _(args):
        ...
        p.reply("away")
    p.run(300)
"""

import re
import signal
import sys
import time

from a09f import Api, Irc


class Peer:
    def __init__(self, user, boss="alice", caps=("server-time", "away-notify"), control=None):
        """`control`: take commands as another user. Needed when messaging
        `user` would change the test: solanum adds whoever a +g user
        messages to their ACCEPT list, so commands sent to the person being
        blocked would let them through."""
        self.user, self.boss = user, boss
        self.irc = Irc(user, caps=caps)
        self.ctrl = Irc(control, caps=caps) if control else self.irc
        self.ctrl_user = control or user
        self.api = Api(user, device=f"e2e peer {user}")
        self.handlers = {}
        self.started = time.time()
        print(f"[peer {user}] ready", flush=True)

    def on(self, name):
        def deco(fn):
            self.handlers[name] = fn
            return fn
        return deco

    def reply(self, text, to=None):
        self.ctrl.send(f"PRIVMSG {to or self.boss} :re:{text}")
        print(f"[peer {self.user}] -> {text}", flush=True)

    def run(self, secs=400):
        # The runner may stop us with SIGTERM: leave test rooms either way, or
        # they pile up across runs (solanum lets a user be in 15 rooms).
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        try:
            self._loop(secs)
        finally:
            self.leave_test_rooms()

    def leave_test_rooms(self):
        """PART every #zz-* test room this peer is in."""
        try:
            rooms = {m.group(1) for l in self.irc.lines
                     for m in [re.search(rf":{self.user}!\S+ JOIN :?(#zz-\S+)", l)] if m}
            for r in sorted(rooms):
                self.irc.send(f"PART {r} :test done")
            self.irc.read(0.5)
        except OSError:
            pass

    def _loop(self, secs):
        rx = re.compile(rf":{self.boss}!\S+ PRIVMSG {self.ctrl_user} :?cmd:(\S+) ?(.*)$")
        end = time.time() + secs
        while time.time() < end:
            if self.ctrl is not self.irc:
                self.irc.read(0.05)                      # keep the other connection drained
            for line in self.ctrl.read(0.3):
                m = rx.search(line)
                if not m:
                    continue
                name, args = m.group(1), m.group(2).strip()
                print(f"[peer {self.user}] <- {name} {args}", flush=True)
                fn = self.handlers.get(name)
                if fn is None:
                    print(f"[peer {self.user}] no handler for {name}", flush=True)
                    continue
                try:
                    fn(args)
                except Exception as e:          # keep going; the scenario will notice
                    print(f"[peer {self.user}] {name} failed: {e!r}", file=sys.stderr, flush=True)
                if name == "bye":
                    return
