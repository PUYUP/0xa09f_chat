"""Peer for long_history.js: seeds 2,500 messages from bob into the test
room's history (straight into Ergo's history database), and removes them."""

from a09f import drop_room, history_sql
from peer import Peer

p = Peer("bob")


@p.on("seed")
def _(room):
    # Same shape as Ergo's stored items (history.Item as JSON), indexed by
    # the casefolded room name and the time in nanoseconds.
    history_sql(f"""
        WITH m AS (
          SELECT g, now() - interval '2 hours' + g * interval '2 seconds' AS t FROM generate_series(1, 2500) g
        ), h AS (
          INSERT INTO history (data, msgid)
          SELECT convert_to(json_build_object(
                   'Type', 1, 'Nick', 'bob!~u@a09f', 'AccountName', 'bob',
                   'Message', json_build_object('Message', 'history line ' || g, 'Msgid', md5('{room}' || g),
                                                'Split', null,
                                                'Time', to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
                   'Tags', null, 'Params', json_build_array('{room}'))::text, 'UTF8'),
                 decode(md5('{room}' || g), 'hex')
          FROM m ORDER BY g
          RETURNING id, convert_from(data, 'UTF8')::json -> 'Message' ->> 'Time' AS time
        )
        INSERT INTO sequence (history_id, target, nanotime)
        SELECT id, convert_to(lower('{room}'), 'UTF8'),
               (extract(epoch FROM time::timestamptz) * 1000000)::bigint * 1000 FROM h""")
    p.reply("seeded")


@p.on("unseed")
def _(room):
    history_sql(f"""WITH d AS (DELETE FROM sequence WHERE target = convert_to(lower('{room}'), 'UTF8') RETURNING history_id)
                    DELETE FROM history WHERE id IN (SELECT history_id FROM d)""")
    drop_room("alice", room)


p.run()
