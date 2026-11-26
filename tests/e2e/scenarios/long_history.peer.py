"""Peer for long_history.js: seeds 2,500 messages into alice's soju history
for the test room (straight into soju's PostgreSQL), and removes them again."""
import subprocess

from a09f import drop_room
from peer import Peer

p = Peer("bob")


def psql(q):
    r = subprocess.run(["docker", "exec", "postgres", "psql", "-U", "soju", "-d", "soju", "-At", "-c", q],
                       capture_output=True, text=True)
    return r.stdout.strip()


def target_id(room):
    return psql(f"""select mt.id from "MessageTarget" mt join "Network" n on n.id=mt.network
                    join "User" u on u.id=n."user" where u.username='alice' and mt.target='{room}'""")


@p.on("seed")
def _(room):
    tid = target_id(room)
    if not tid:          # soju creates the target with the first stored message
        psql(f"""insert into "MessageTarget" (network, target) select n.id, '{room}' from "Network" n
                 join "User" u on u.id=n."user" where u.username='alice' limit 1""")
        tid = target_id(room)
    psql(f"""insert into "Message" (target, raw, time, sender, text)
             select {tid}, '@time=' || to_char((now() - interval '2 hours' + g * interval '2 seconds') at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || ' :bob!~bob@172.30.99.30 PRIVMSG {room} :history line ' || g,
               now() - interval '2 hours' + g * interval '2 seconds', 'bob', 'history line ' || g
             from generate_series(1, 2500) g""")
    p.reply("seeded")


@p.on("unseed")
def _(room):
    tid = target_id(room)
    if tid:
        psql(f'delete from "MessageTarget" where id={tid}')
    drop_room("alice", room)


p.run()
