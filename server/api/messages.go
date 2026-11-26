package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/jackc/pgx/v5"
)

// msgKey identifies one message: sender, target (room, or the person a
// private message was sent to), server time (ms) and a hash of the text.
type msgKey struct {
	Sender string `json:"sender"`
	Target string `json:"target"`
	Time   int64  `json:"time"`
	Hash   string `json:"hash"`
}

func (k msgKey) with(extra obj) obj {
	o := obj{"sender": k.Sender, "target": k.Target, "time": k.Time, "hash": k.Hash}
	for a, b := range extra {
		o[a] = b
	}
	return o
}

// key reads a message key from the body; senderDefault is used when the
// body has no "sender" (my own message). The target may come as "room".
func (q *req) key(senderDefault string) (msgKey, error) {
	sender := q.lower("sender")
	if !q.has("sender") {
		sender = senderDefault
	}
	target := q.lower("target")
	if !q.has("target") {
		target = q.lower("room")
	}
	h := cut(q.raw("hash"), 16)
	t, ok := q.integer("time")
	if !ok || !validID(sender) || target == "" || !hashRe.MatchString(h) {
		return msgKey{}, errBad
	}
	return msgKey{sender, target, t, h}, nil
}

// tell: everyone for a room (the service doesn't know who's in it),
// else both people of the private chat (and me).
func (s *server) tell(k msgKey, me, event string, data obj) {
	if isRoom(k.Target) {
		s.hub.pushAll(event, data)
	} else {
		s.hub.pushMany([]string{k.Target, k.Sender, me}, event, data)
	}
}

// convWhere: SQL filter for a conversation: a room, or the private chat
// me <-> conv. Arguments start at $1.
func convWhere(me, conv string) (string, []any) {
	if isRoom(conv) {
		return "target = $1", []any{conv}
	}
	return "((sender = $1 AND target = $2) OR (sender = $2 AND target = $1))", []any{me, conv}
}

// ---- deleted messages ----

const maxRedactAge = 30 * 24 * 3600

func (s *server) storeRedaction(ctx context.Context, k msgKey) error {
	if _, err := s.db.Exec(ctx, `INSERT INTO redactions (sender, target, msg_time, hash, created) VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT DO NOTHING`, k.Sender, k.Target, k.Time, k.Hash, now()); err != nil {
		return err
	}
	_, err := s.db.Exec(ctx, `DELETE FROM redactions WHERE created < $1`, now()-maxRedactAge)
	return err
}

// POST /redact {"target","time","hash"}: delete my message for everyone.
func (s *server) redact(q *req) (any, error) {
	target := q.lower("target")
	h := cut(q.raw("hash"), 16)
	t, ok := q.integer("time")
	if !ok || target == "" || !hashRe.MatchString(h) {
		return nil, errBad
	}
	k := msgKey{q.me, target, t, h}
	if err := s.storeRedaction(q.r.Context(), k); err != nil {
		return nil, err
	}
	s.tell(k, q.me, "redact", k.with(nil))
	return obj{}, nil
}

func (s *server) getRedactions(q *req) (any, error) {
	var since int64
	fmt.Sscan(q.query("since"), &since)
	rows, err := s.db.Query(q.r.Context(), `SELECT sender, target, msg_time, hash FROM redactions WHERE created >= $1 ORDER BY created`, since)
	if err != nil {
		return nil, err
	}
	out, err := collect(rows, func(r pgx.Rows) (msgKey, error) {
		var k msgKey
		return k, r.Scan(&k.Sender, &k.Target, &k.Time, &k.Hash)
	})
	return obj{"redactions": out}, err
}

// ---- reactions, edits, pins ----

var reactions = map[string]bool{"👍": true, "❤️": true, "😂": true, "😮": true, "😢": true, "🙏": true, "🎉": true, "🔥": true}

func (s *server) react(q *req) (any, error) {
	ctx := q.r.Context()
	k, err := q.key("")
	if err != nil {
		return nil, err
	}
	emoji := q.raw("emoji")
	on := q.boolean("on")
	if !reactions[emoji] {
		return nil, fail(400, "That reaction isn't available.")
	}
	if on {
		_, err = s.db.Exec(ctx, `INSERT INTO reactions VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
			k.Sender, k.Target, k.Time, k.Hash, q.me, emoji, now())
	} else {
		_, err = s.db.Exec(ctx, `DELETE FROM reactions WHERE sender=$1 AND target=$2 AND msg_time=$3 AND hash=$4 AND uname=$5 AND emoji=$6`,
			k.Sender, k.Target, k.Time, k.Hash, q.me, emoji)
	}
	if err != nil {
		return nil, err
	}
	s.tell(k, q.me, "reaction", k.with(obj{"user": q.me, "emoji": emoji, "on": on}))
	return obj{}, nil
}

func (s *server) edit(q *req) (any, error) {
	k, err := q.key(q.me)
	if err != nil {
		return nil, err
	}
	text := cut(strings.TrimSpace(oneLine(q.raw("text"))), 400)
	if text == "" {
		return nil, fail(400, "The message can't be empty.")
	}
	if k.Sender != q.me {
		return nil, fail(403, "You can only edit your own messages.")
	}
	if _, err := s.db.Exec(q.r.Context(), `INSERT INTO edits VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (sender, target, msg_time, hash) DO UPDATE SET text = excluded.text, edited = excluded.edited`,
		k.Sender, k.Target, k.Time, k.Hash, text, now()); err != nil {
		return nil, err
	}
	s.tell(k, q.me, "edit", k.with(obj{"text": text}))
	return obj{}, nil
}

const maxPins = 5

func (s *server) pin(q *req) (any, error) {
	ctx := q.r.Context()
	room := q.lower("room")
	if !isRoom(room) {
		return nil, fail(400, "Only room messages can be pinned.")
	}
	k, err := q.key("")
	if err != nil {
		return nil, err
	}
	if q.boolean("on") {
		var n int
		s.db.QueryRow(ctx, `SELECT COUNT(*) FROM pins WHERE room = $1`, room).Scan(&n)
		if n >= maxPins {
			return nil, fail(409, fmt.Sprintf("A room can have at most %d pinned messages.", maxPins))
		}
		_, err = s.db.Exec(ctx, `INSERT INTO pins VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (room, sender, msg_time, hash) DO UPDATE SET text = excluded.text, pinned_by = excluded.pinned_by,
			created = excluded.created`, room, k.Sender, k.Time, k.Hash, cut(q.raw("text"), 400), q.me, now())
	} else {
		_, err = s.db.Exec(ctx, `DELETE FROM pins WHERE room=$1 AND sender=$2 AND msg_time=$3 AND hash=$4`, room, k.Sender, k.Time, k.Hash)
	}
	if err != nil {
		return nil, err
	}
	s.hub.pushAll("pins", obj{"room": room})
	return obj{}, nil
}

// GET /msgmeta?conv=[&from=&to=]: reactions, edits, expiries (+ pins) of a
// conversation, optionally only for messages sent between from..to (ms).
func (s *server) getMsgMeta(q *req) (any, error) {
	ctx := q.r.Context()
	conv := strings.ToLower(strings.TrimSpace(q.query("conv")))
	from, to := int64(0), int64(1)<<62
	if v := q.query("from"); v != "" {
		if _, err := fmt.Sscan(v, &from); err != nil {
			return nil, errBad
		}
	}
	if v := q.query("to"); v != "" {
		if _, err := fmt.Sscan(v, &to); err != nil {
			return nil, errBad
		}
	}
	where, args := convWhere(q.me, conv)
	n := len(args)
	rng := fmt.Sprintf(" AND msg_time >= $%d AND msg_time <= $%d", n+1, n+2)
	args = append(args, from, to)

	rows, err := s.db.Query(ctx, `SELECT sender, target, msg_time, hash, uname, emoji FROM reactions WHERE `+where+rng, args...)
	if err != nil {
		return nil, err
	}
	reacts, err := collect(rows, func(r pgx.Rows) (obj, error) {
		var k msgKey
		var u, e string
		err := r.Scan(&k.Sender, &k.Target, &k.Time, &k.Hash, &u, &e)
		return k.with(obj{"user": u, "emoji": e}), err
	})
	if err != nil {
		return nil, err
	}
	rows, err = s.db.Query(ctx, `SELECT sender, target, msg_time, hash, text FROM edits WHERE `+where+rng, args...)
	if err != nil {
		return nil, err
	}
	edits, err := collect(rows, func(r pgx.Rows) (obj, error) {
		var k msgKey
		var t string
		err := r.Scan(&k.Sender, &k.Target, &k.Time, &k.Hash, &t)
		return k.with(obj{"text": t}), err
	})
	if err != nil {
		return nil, err
	}
	rows, err = s.db.Query(ctx, `SELECT sender, target, msg_time, hash, due FROM expiring WHERE `+where+rng, args...)
	if err != nil {
		return nil, err
	}
	exp, err := collect(rows, func(r pgx.Rows) (obj, error) {
		var k msgKey
		var d int64
		err := r.Scan(&k.Sender, &k.Target, &k.Time, &k.Hash, &d)
		return k.with(obj{"due": d}), err
	})
	if err != nil {
		return nil, err
	}
	pins := []obj{}
	if isRoom(conv) {
		if pins, err = s.pinsFor(ctx, conv); err != nil {
			return nil, err
		}
	}
	return obj{"reactions": reacts, "edits": edits, "expiring": exp, "pins": pins}, nil
}

func (s *server) pinsFor(ctx context.Context, room string) ([]obj, error) {
	rows, err := s.db.Query(ctx, `SELECT sender, msg_time, hash, text, pinned_by FROM pins WHERE room = $1 ORDER BY created`, room)
	if err != nil {
		return nil, err
	}
	return collect(rows, func(r pgx.Rows) (obj, error) {
		var sender, hash, text, by string
		var t int64
		err := r.Scan(&sender, &t, &hash, &text, &by)
		return obj{"sender": sender, "time": t, "hash": hash, "text": text, "pinnedBy": by}, err
	})
}

// ---- polls ----

func (s *server) createPoll(q *req) (any, error) {
	room := q.lower("room")
	if !isRoom(room) {
		return nil, fail(400, "Polls are for rooms.")
	}
	question := cut(squash(q.raw("question")), 200)
	var opts []string
	if list, ok := q.body["options"].([]any); ok {
		for _, o := range list {
			if t := strings.TrimSpace(toStr(o)); t != "" && len(opts) < 8 {
				opts = append(opts, cut(squash(t), 80))
			}
		}
	}
	if question == "" || len(opts) < 2 {
		return nil, fail(400, "A poll needs a question and at least 2 choices.")
	}
	data, _ := json.Marshal(opts)
	var id int64
	if err := s.db.QueryRow(q.r.Context(), `INSERT INTO polls (room, author, question, options, created) VALUES ($1,$2,$3,$4,$5)
		RETURNING id`, room, q.me, question, data, now()).Scan(&id); err != nil {
		return nil, err
	}
	return obj{"id": id}, nil
}

func (s *server) pollState(ctx context.Context, me string, id int64) (obj, error) {
	var room, author, question string
	var data []byte
	var created int64
	if err := s.db.QueryRow(ctx, `SELECT room, author, question, options, created FROM polls WHERE id = $1`, id).
		Scan(&room, &author, &question, &data, &created); err != nil {
		if noRows(err) {
			return nil, fail(404, "That poll isn't there any more.")
		}
		return nil, err
	}
	var opts []string
	json.Unmarshal(data, &opts)
	counts := make([]int, len(opts))
	voters := make([][]string, len(opts))
	for i := range voters {
		voters[i] = []string{}
	}
	var mine any
	rows, err := s.db.Query(ctx, `SELECT uname, opt FROM poll_votes WHERE poll = $1 ORDER BY uname`, id)
	if err != nil {
		return nil, err
	}
	type v struct {
		u string
		o int
	}
	votes, err := collect(rows, func(r pgx.Rows) (v, error) { var x v; return x, r.Scan(&x.u, &x.o) })
	if err != nil {
		return nil, err
	}
	for _, x := range votes {
		if x.o >= 0 && x.o < len(opts) {
			counts[x.o]++
			voters[x.o] = append(voters[x.o], x.u)
		}
		if x.u == me {
			mine = x.o
		}
	}
	return obj{"id": id, "room": room, "author": author, "question": question, "options": opts,
		"counts": counts, "voters": voters, "mine": mine, "created": created}, nil
}

func (s *server) getPoll(q *req) (any, error) {
	var id int64
	fmt.Sscan(q.query("id"), &id)
	return s.pollState(q.r.Context(), q.me, id)
}

func (s *server) vote(q *req) (any, error) {
	ctx := q.r.Context()
	id := q.intOr("id", 0)
	st, err := s.pollState(ctx, q.me, id)
	if err != nil {
		return nil, err
	}
	if q.body["option"] == nil {
		_, err = s.db.Exec(ctx, `DELETE FROM poll_votes WHERE poll = $1 AND uname = $2`, id, q.me)
	} else {
		opt, ok := q.integer("option")
		if !ok {
			return nil, errBad
		}
		if opt < 0 || int(opt) >= len(st["options"].([]string)) {
			return nil, fail(400, "That choice isn't in the poll.")
		}
		_, err = s.db.Exec(ctx, `INSERT INTO poll_votes VALUES ($1,$2,$3) ON CONFLICT (poll, uname) DO UPDATE SET opt = excluded.opt`,
			id, q.me, opt)
	}
	if err != nil {
		return nil, err
	}
	s.hub.pushAll("poll", obj{"id": id})
	return obj{}, nil
}

// ---- reminders ----

const maxReminder = 30 * 24 * 3600

func (s *server) remind(q *req) (any, error) {
	text := cut(squash(q.raw("text")), 200)
	minutes, ok := toFloat(q.body["minutes"])
	if !ok {
		return nil, fail(400, "When should I remind you?")
	}
	secs := int64(minutes * 60)
	if text == "" || secs < 60 || secs > maxReminder {
		return nil, fail(400, "Reminders can be set from 1 minute to 30 days ahead.")
	}
	due := now() + secs
	var id int64
	if err := s.db.QueryRow(q.r.Context(), `INSERT INTO reminders (uname, text, due) VALUES ($1,$2,$3) RETURNING id`,
		q.me, text, due).Scan(&id); err != nil {
		return nil, err
	}
	return obj{"id": id, "text": text, "due": due}, nil
}

type reminder struct {
	ID   int64  `json:"id"`
	User string `json:"user,omitempty"`
	Text string `json:"text"`
	Due  int64  `json:"due"`
}

// dueReminders: due and not delivered (for one user, or everyone with "").
func (s *server) dueReminders(ctx context.Context, user string) ([]reminder, error) {
	rows, err := s.db.Query(ctx, `SELECT id, uname, text, due FROM reminders WHERE NOT delivered AND due <= $1
		AND ($2 = '' OR uname = $2) ORDER BY due`, now(), user)
	if err != nil {
		return nil, err
	}
	return collect(rows, func(r pgx.Rows) (reminder, error) { var x reminder; return x, r.Scan(&x.ID, &x.User, &x.Text, &x.Due) })
}

func (s *server) markDelivered(ctx context.Context, list []reminder) {
	idList := make([]int64, len(list))
	for i, r := range list {
		idList[i] = r.ID
	}
	if len(idList) > 0 {
		s.db.Exec(ctx, `UPDATE reminders SET delivered = TRUE WHERE id = ANY($1)`, idList)
	}
}

func (s *server) getReminders(q *req) (any, error) {
	rows, err := s.db.Query(q.r.Context(), `SELECT id, text, due FROM reminders WHERE uname = $1 AND NOT delivered ORDER BY due`, q.me)
	if err != nil {
		return nil, err
	}
	out, err := collect(rows, func(r pgx.Rows) (reminder, error) { var x reminder; return x, r.Scan(&x.ID, &x.Text, &x.Due) })
	return obj{"reminders": out}, err
}

func (s *server) getDueReminders(q *req) (any, error) {
	ctx := q.r.Context()
	due, err := s.dueReminders(ctx, q.me)
	if err != nil {
		return nil, err
	}
	s.markDelivered(ctx, due)
	return obj{"reminders": due}, nil
}

// ---- disappearing messages ----

const maxExpire = 7 * 24 * 3600

func (s *server) expire(q *req) (any, error) {
	k, err := q.key(q.me)
	if err != nil {
		return nil, err
	}
	after := q.intOr("after", 0)
	if k.Sender != q.me || after < 10 || after > maxExpire {
		return nil, errBad
	}
	due := k.Time/1000 + after
	if _, err := s.db.Exec(q.r.Context(), `INSERT INTO expiring VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (sender, target, msg_time, hash) DO UPDATE SET due = excluded.due`, k.Sender, k.Target, k.Time, k.Hash, due); err != nil {
		return nil, err
	}
	s.tell(k, q.me, "expire", k.with(obj{"due": due}))
	return obj{}, nil
}

// expireDue turns due disappearing messages into deletions and tells people.
func (s *server) expireDue(ctx context.Context) {
	rows, err := s.db.Query(ctx, `DELETE FROM expiring WHERE due <= $1 RETURNING sender, target, msg_time, hash`, now())
	if err != nil {
		return
	}
	keys, _ := collect(rows, func(r pgx.Rows) (msgKey, error) {
		var k msgKey
		return k, r.Scan(&k.Sender, &k.Target, &k.Time, &k.Hash)
	})
	for _, k := range keys {
		s.storeRedaction(ctx, k)
		s.tell(k, k.Sender, "redact", k.with(nil))
	}
}

// ---- saved messages ----

func (s *server) save(q *req) (any, error) {
	ctx := q.r.Context()
	k, err := q.key("")
	if err != nil {
		return nil, err
	}
	if q.boolean("on") {
		_, err = s.db.Exec(ctx, `INSERT INTO saved VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			ON CONFLICT (uname, sender, target, msg_time, hash) DO UPDATE SET conv = excluded.conv, text = excluded.text,
			created = excluded.created`, q.me, k.Sender, k.Target, k.Time, k.Hash, cut(q.raw("conv"), 60), cut(q.raw("text"), 500), now())
	} else {
		_, err = s.db.Exec(ctx, `DELETE FROM saved WHERE uname=$1 AND sender=$2 AND target=$3 AND msg_time=$4 AND hash=$5`,
			q.me, k.Sender, k.Target, k.Time, k.Hash)
	}
	if err != nil {
		return nil, err
	}
	s.hub.push(q.me, "saved-changed", obj{})
	return obj{}, nil
}

func (s *server) getSaved(q *req) (any, error) {
	rows, err := s.db.Query(q.r.Context(), `SELECT sender, target, msg_time, hash, conv, text FROM saved WHERE uname = $1
		ORDER BY created DESC LIMIT 300`, q.me)
	if err != nil {
		return nil, err
	}
	out, err := collect(rows, func(r pgx.Rows) (obj, error) {
		var k msgKey
		var conv, text string
		err := r.Scan(&k.Sender, &k.Target, &k.Time, &k.Hash, &conv, &text)
		return k.with(obj{"conv": conv, "text": text}), err
	})
	return obj{"saved": out}, err
}

// ---- scheduled messages (sent by the service, as the user) ----

const (
	maxScheduled     = 50
	maxScheduleAhead = 30 * 24 * 3600
)

func (s *server) schedule(q *req) (any, error) {
	ctx := q.r.Context()
	target := q.str("target")
	if !(validID(strings.ToLower(target)) || roomOK(target)) {
		return nil, fail(400, "Bad target.")
	}
	text := cut(strings.TrimSpace(oneLine(q.raw("text"))), 400)
	due, ok := q.integer("due")
	if !ok {
		return nil, errBad
	}
	t := now()
	if text == "" {
		return nil, fail(400, "The message is empty.")
	}
	if due < t+30 || due > t+maxScheduleAhead {
		return nil, fail(400, "Pick a time between 1 minute and 30 days from now.")
	}
	var n int
	s.db.QueryRow(ctx, `SELECT COUNT(*) FROM scheduled WHERE uname = $1 AND NOT sent`, q.me).Scan(&n)
	if n >= maxScheduled {
		return nil, fail(409, fmt.Sprintf("You already have %d scheduled messages.", maxScheduled))
	}
	var id int64
	if err := s.db.QueryRow(ctx, `INSERT INTO scheduled (uname, target, text, due) VALUES ($1,$2,$3,$4) RETURNING id`,
		q.me, target, text, due).Scan(&id); err != nil {
		return nil, err
	}
	s.hub.push(q.me, "scheduled-changed", obj{})
	return obj{"id": id, "target": target, "text": text, "due": due}, nil
}

func (s *server) getScheduled(q *req) (any, error) {
	rows, err := s.db.Query(q.r.Context(), `SELECT id, target, text, due FROM scheduled WHERE uname = $1 AND NOT sent ORDER BY due`, q.me)
	if err != nil {
		return nil, err
	}
	out, err := collect(rows, func(r pgx.Rows) (obj, error) {
		var id, due int64
		var target, text string
		err := r.Scan(&id, &target, &text, &due)
		return obj{"id": id, "target": target, "text": text, "due": due}, err
	})
	return obj{"scheduled": out}, err
}

func (s *server) cancelScheduled(q *req) (any, error) {
	id, ok := q.integer("id")
	if !ok {
		return nil, errBad
	}
	if _, err := s.db.Exec(q.r.Context(), `DELETE FROM scheduled WHERE id = $1 AND uname = $2 AND NOT sent`, id, q.me); err != nil {
		return nil, err
	}
	s.hub.push(q.me, "scheduled-changed", obj{})
	return obj{}, nil
}

// sendScheduled delivers due scheduled messages: the service signs in as the
// user (one more, away, device) and sends the line.
func (s *server) sendScheduled(ctx context.Context) {
	rows, err := s.db.Query(ctx, `UPDATE scheduled SET sent = TRUE WHERE NOT sent AND due <= $1 RETURNING id, uname, target, text`, now())
	if err != nil {
		return
	}
	type sm struct {
		id                 int64
		user, target, text string
	}
	list, _ := collect(rows, func(r pgx.Rows) (sm, error) { var x sm; return x, r.Scan(&x.id, &x.user, &x.target, &x.text) })
	byUser := map[string][]sm{}
	for _, m := range list {
		byUser[m.user] = append(byUser[m.user], m)
	}
	for user, ms := range byUser {
		lines := make([]string, 0, len(ms))
		for _, m := range ms {
			lines = append(lines, fmt.Sprintf("PRIVMSG %s :%s", m.target, m.text))
		}
		go func(user string, lines []string) {
			if err := s.ergo.actAs(context.Background(), user, lines); err != nil {
				log.Printf("scheduled messages of %s: %v", user, err)
			}
			s.hub.push(user, "scheduled-changed", obj{})
		}(user, lines)
	}
}

// ---- announcements (admins) ----

func (s *server) announce(q *req) (any, error) {
	if !s.cfg.admins[q.me] {
		return nil, fail(403, "Only a09f admins can send announcements.")
	}
	text := cut(squash(q.raw("text")), 500)
	if text == "" {
		return nil, fail(400, "Please write the announcement first.")
	}
	t := now()
	var id int64
	if err := s.db.QueryRow(q.r.Context(), `INSERT INTO announcements (author, text, created) VALUES ($1,$2,$3) RETURNING id`,
		q.me, text, t).Scan(&id); err != nil {
		return nil, err
	}
	item := obj{"id": id, "author": q.me, "text": text, "created": t}
	s.hub.pushAll("announcement", item)
	log.Printf("announcement #%d by %s", id, q.me)
	return item, nil
}

func (s *server) getAnnouncements(q *req) (any, error) {
	var after int64
	fmt.Sscan(q.query("after"), &after)
	rows, err := s.db.Query(q.r.Context(), `SELECT id, author, text, created FROM
		(SELECT id, author, text, created FROM announcements WHERE id > $1 AND created >= $2 ORDER BY id DESC LIMIT 5) x
		ORDER BY id`, after, now()-7*24*3600)
	if err != nil {
		return nil, err
	}
	out, err := collect(rows, func(r pgx.Rows) (obj, error) {
		var id, created int64
		var author, text string
		err := r.Scan(&id, &author, &text, &created)
		return obj{"id": id, "author": author, "text": text, "created": created}, err
	})
	return obj{"announcements": out}, err
}
