package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	maxGroupLen   = 24
	maxRequestMsg = 140
	defaultGroup  = "Friends"
	maxIgnore     = 200
)

func cleanGroup(g string) string {
	g = cut(squash(g), maxGroupLen)
	if g == "" {
		return defaultGroup
	}
	return g
}

func (s *server) friendsOf(ctx context.Context, user string) []string {
	rows, err := s.db.Query(ctx, `SELECT friend FROM friends WHERE owner = $1`, user)
	if err != nil {
		return nil
	}
	out, _ := collect(rows, func(r pgx.Rows) (string, error) { var f string; return f, r.Scan(&f) })
	return out
}

func (s *server) areFriends(ctx context.Context, a, b string) bool {
	var one int
	return s.db.QueryRow(ctx, `SELECT 1 FROM friends WHERE owner = $1 AND friend = $2`, a, b).Scan(&one) == nil
}

func (s *server) friendsState(ctx context.Context, me string) (obj, error) {
	type friend struct {
		Nick  string `json:"nick"`
		Group string `json:"group"`
	}
	type incoming struct {
		From    string `json:"from"`
		Msg     string `json:"msg"`
		Created int64  `json:"created"`
	}
	type outgoing struct {
		To    string `json:"to"`
		Group string `json:"group"`
	}
	rows, err := s.db.Query(ctx, `SELECT friend, grp FROM friends WHERE owner = $1 ORDER BY friend`, me)
	if err != nil {
		return nil, err
	}
	fr, err := collect(rows, func(r pgx.Rows) (friend, error) { var f friend; return f, r.Scan(&f.Nick, &f.Group) })
	if err != nil {
		return nil, err
	}
	rows, err = s.db.Query(ctx, `SELECT from_user, msg, created FROM friend_requests WHERE to_user = $1 ORDER BY created`, me)
	if err != nil {
		return nil, err
	}
	in, err := collect(rows, func(r pgx.Rows) (incoming, error) { var x incoming; return x, r.Scan(&x.From, &x.Msg, &x.Created) })
	if err != nil {
		return nil, err
	}
	rows, err = s.db.Query(ctx, `SELECT to_user, grp FROM friend_requests WHERE from_user = $1 ORDER BY to_user`, me)
	if err != nil {
		return nil, err
	}
	out, err := collect(rows, func(r pgx.Rows) (outgoing, error) { var x outgoing; return x, r.Scan(&x.To, &x.Group) })
	if err != nil {
		return nil, err
	}
	return obj{"friends": fr, "incoming": in, "outgoing": out}, nil
}

func (s *server) getFriends(q *req) (any, error) { return s.friendsState(q.r.Context(), q.me) }

// befriend makes a and b friends (both rows) and clears their requests.
func befriend(ctx context.Context, tx pgx.Tx, a, b, grpA, grpB string) error {
	t := now()
	if _, err := tx.Exec(ctx, `INSERT INTO friends (owner, friend, grp, added) VALUES ($1,$2,$3,$5), ($2,$1,$4,$5)
		ON CONFLICT DO NOTHING`, a, b, grpA, grpB, t); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM friend_requests WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)`, a, b)
	return err
}

// friendChange runs one change to the friends list in a transaction, then
// tells my other devices and returns the new state (like every /friends/* call).
func (s *server) friendChange(q *req, fn func(ctx context.Context, tx pgx.Tx) (string, func(), error)) (any, error) {
	ctx := q.r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	result, after, err := fn(ctx, tx)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if after != nil {
		after()
	}
	s.hub.push(q.me, "friends-changed", obj{"sid": q.sid})
	st, err := s.friendsState(ctx, q.me)
	if err != nil {
		return nil, err
	}
	st["result"] = result
	return st, nil
}

func (s *server) friendRequest(q *req) (any, error) {
	me, to := q.me, q.lower("to")
	if !validID(to) {
		return nil, fail(400, "That doesn't look like an a09f ID.")
	}
	group := cleanGroup(q.raw("group"))
	msg := cut(squash(q.raw("msg")), maxRequestMsg)
	return s.friendChange(q, func(ctx context.Context, tx pgx.Tx) (string, func(), error) {
		var one int
		var grp string
		if to == me {
			return "", nil, fail(400, "That's you!")
		}
		if tx.QueryRow(ctx, `SELECT 1 FROM friends WHERE owner = $1 AND friend = $2`, me, to).Scan(&one) == nil {
			return "", nil, fail(409, to+" is already your friend.")
		}
		if !s.bouncer.accountExists(ctx, to) {
			return "", nil, fail(404, fmt.Sprintf("There's no a09f user with the ID \"%s\".", to))
		}
		// They already asked us: that's a yes from both sides.
		if tx.QueryRow(ctx, `SELECT grp FROM friend_requests WHERE from_user = $1 AND to_user = $2`, to, me).Scan(&grp) == nil {
			if err := befriend(ctx, tx, me, to, group, grp); err != nil {
				return "", nil, err
			}
			return "friends", func() { s.hub.push(to, "friend-accepted", obj{"nick": me}) }, nil
		}
		// Already friends from their side only (we removed them earlier): just re-add.
		if tx.QueryRow(ctx, `SELECT 1 FROM friends WHERE owner = $1 AND friend = $2`, to, me).Scan(&one) == nil {
			_, err := tx.Exec(ctx, `INSERT INTO friends (owner, friend, grp, added) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
				me, to, group, now())
			return "friends", nil, err
		}
		_, err := tx.Exec(ctx, `INSERT INTO friend_requests (from_user, to_user, grp, msg, created) VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (from_user, to_user) DO UPDATE SET grp = excluded.grp, msg = excluded.msg, created = excluded.created`,
			me, to, group, msg, now())
		return "requested", func() { s.hub.push(to, "friend-request", obj{"from": me, "msg": msg}) }, err
	})
}

func (s *server) friendRespond(q *req) (any, error) {
	me, frm := q.me, q.lower("from")
	accept := q.boolean("accept")
	group := cleanGroup(q.raw("group"))
	return s.friendChange(q, func(ctx context.Context, tx pgx.Tx) (string, func(), error) {
		var grp string
		if tx.QueryRow(ctx, `SELECT grp FROM friend_requests WHERE from_user = $1 AND to_user = $2`, frm, me).Scan(&grp) != nil {
			return "", nil, fail(404, "That friend request isn't there any more.")
		}
		if accept {
			if err := befriend(ctx, tx, me, frm, group, grp); err != nil {
				return "", nil, err
			}
			return "ok", func() { s.hub.push(frm, "friend-accepted", obj{"nick": me}) }, nil
		}
		_, err := tx.Exec(ctx, `DELETE FROM friend_requests WHERE from_user = $1 AND to_user = $2`, frm, me)
		return "ok", func() { s.hub.push(frm, "friend-declined", obj{"nick": me}) }, err
	})
}

// friendRemove ends a friendship on both sides (or cancels my pending request).
func (s *server) friendRemove(q *req) (any, error) {
	me, nick := q.me, q.lower("nick")
	return s.friendChange(q, func(ctx context.Context, tx pgx.Tx) (string, func(), error) {
		r1, err := tx.Exec(ctx, `DELETE FROM friends WHERE (owner = $1 AND friend = $2) OR (owner = $2 AND friend = $1)`, me, nick)
		if err != nil {
			return "", nil, err
		}
		r2, err := tx.Exec(ctx, `DELETE FROM friend_requests WHERE from_user = $1 AND to_user = $2`, me, nick)
		if err != nil {
			return "", nil, err
		}
		switch {
		case r1.RowsAffected() > 0:
			return "ok", func() { s.hub.push(nick, "friend-removed", obj{"nick": me}) }, nil
		case r2.RowsAffected() > 0:
			return "ok", func() { s.hub.push(nick, "friend-request-cancelled", obj{"nick": me}) }, nil
		}
		return "ok", nil, nil
	})
}

func (s *server) friendMove(q *req) (any, error) {
	me, nick, g := q.me, q.lower("nick"), cleanGroup(q.raw("group"))
	return s.friendChange(q, func(ctx context.Context, tx pgx.Tx) (string, func(), error) {
		if _, err := tx.Exec(ctx, `UPDATE friends SET grp = $1 WHERE owner = $2 AND friend = $3`, g, me, nick); err != nil {
			return "", nil, err
		}
		_, err := tx.Exec(ctx, `UPDATE friend_requests SET grp = $1 WHERE from_user = $2 AND to_user = $3`, g, me, nick)
		return "ok", nil, err
	})
}

func (s *server) friendRenameGroup(q *req) (any, error) {
	me, old, g := q.me, q.raw("from"), cleanGroup(q.raw("to"))
	return s.friendChange(q, func(ctx context.Context, tx pgx.Tx) (string, func(), error) {
		if _, err := tx.Exec(ctx, `UPDATE friends SET grp = $1 WHERE owner = $2 AND grp = $3`, g, me, old); err != nil {
			return "", nil, err
		}
		_, err := tx.Exec(ctx, `UPDATE friend_requests SET grp = $1 WHERE from_user = $2 AND grp = $3`, g, me, old)
		return "ok", nil, err
	})
}

// ---- privacy preferences ----

type prefs struct {
	Ignore      []string `json:"ignore"`
	FriendsOnly bool     `json:"friendsOnly"`
}

func (s *server) prefsOf(ctx context.Context, user string) prefs {
	p := prefs{Ignore: []string{}}
	var data []byte
	if s.db.QueryRow(ctx, `SELECT data FROM prefs WHERE owner = $1`, user).Scan(&data) == nil {
		json.Unmarshal(data, &p)
		if p.Ignore == nil {
			p.Ignore = []string{}
		}
	}
	return p
}

func (s *server) getPrefs(q *req) (any, error) {
	p := s.prefsOf(q.r.Context(), q.me)
	return obj{"ignore": p.Ignore, "friendsOnly": p.FriendsOnly}, nil
}

func (s *server) setPrefs(q *req) (any, error) {
	ctx := q.r.Context()
	p := s.prefsOf(ctx, q.me)
	if q.has("ignore") {
		set := map[string]bool{}
		if list, ok := q.body["ignore"].([]any); ok {
			for _, v := range list {
				if u := strings.ToLower(strings.TrimSpace(toStr(v))); validID(u) && u != q.me {
					set[u] = true
				}
			}
		}
		clean := make([]string, 0, len(set))
		for u := range set {
			clean = append(clean, u)
		}
		sort.Strings(clean)
		if len(clean) > maxIgnore {
			return nil, fail(400, fmt.Sprintf("You can ignore at most %d people.", maxIgnore))
		}
		p.Ignore = clean
	}
	if q.has("friendsOnly") {
		p.FriendsOnly = q.boolean("friendsOnly")
	}
	data, _ := json.Marshal(p)
	if _, err := s.db.Exec(ctx, `INSERT INTO prefs (owner, data) VALUES ($1, $2)
		ON CONFLICT (owner) DO UPDATE SET data = excluded.data`, q.me, data); err != nil {
		return nil, err
	}
	s.hub.push(q.me, "prefs-changed", obj{"sid": q.sid})
	return obj{"ignore": p.Ignore, "friendsOnly": p.FriendsOnly}, nil
}

// ---- find people ----

func tzDistance(a, b int) int {
	d := (a - b) % 1440
	if d < 0 {
		d = -d
	}
	if 1440-d < d {
		return 1440 - d
	}
	return d
}

func (s *server) searchUsers(q *req) (any, error) {
	ctx := q.r.Context()
	needle := strings.ToLower(strings.TrimSpace(q.query("q")))
	if len([]rune(needle)) < 2 {
		return nil, fail(400, "Type at least 2 letters.")
	}
	var hits []string
	for _, u := range s.bouncer.allAccounts(ctx) {
		if strings.Contains(u, needle) && u != q.me {
			hits = append(hits, u)
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		a, b := hits[i], hits[j]
		pa, pb := strings.HasPrefix(a, needle), strings.HasPrefix(b, needle)
		if pa != pb {
			return pa
		}
		if len(a) != len(b) {
			return len(a) < len(b)
		}
		return a < b
	})
	if len(hits) > 60 {
		hits = hits[:60]
	}
	tzs, err := s.userTz(ctx, append(append([]string{}, hits...), q.me))
	if err != nil {
		return nil, err
	}
	if mine, ok := tzs[q.me]; ok { // nearest timezone first; unknown ones last
		dist := func(u string) int {
			if t, ok := tzs[u]; ok {
				return tzDistance(mine.Offset, t.Offset)
			}
			return 1_000_000
		}
		sort.SliceStable(hits, func(i, j int) bool { return dist(hits[i]) < dist(hits[j]) })
	}
	if len(hits) > 20 {
		hits = hits[:20]
	}
	tz := obj{}
	for _, u := range hits {
		if t, ok := tzs[u]; ok {
			tz[u] = t
		}
	}
	if hits == nil {
		hits = []string{}
	}
	return obj{"users": hits, "tz": tz}, nil
}

// ---- friend suggestions ----

func (s *server) getSuggestions(q *req) (any, error) {
	ctx := q.r.Context()
	me := q.me
	skip := map[string]bool{me: true}
	friends := s.friendsOf(ctx, me)
	for _, f := range friends {
		skip[f] = true
	}
	rows, err := s.db.Query(ctx, `SELECT to_user FROM friend_requests WHERE from_user = $1
		UNION SELECT from_user FROM friend_requests WHERE to_user = $1`, me)
	if err != nil {
		return nil, err
	}
	pending, _ := collect(rows, func(r pgx.Rows) (string, error) { var u string; return u, r.Scan(&u) })
	for _, u := range pending {
		skip[u] = true
	}
	for _, u := range s.prefsOf(ctx, me).Ignore {
		skip[u] = true
	}
	score := map[string]int{}
	why := map[string][]string{}
	add := func(u string, pts int, reason string) {
		if skip[u] {
			return
		}
		score[u] += pts
		for _, r := range why[u] {
			if r == reason {
				return
			}
		}
		why[u] = append(why[u], reason)
	}
	// friends of friends
	mutual := map[string][]string{}
	var order []string
	if len(friends) > 0 {
		rows, err = s.db.Query(ctx, `SELECT owner, friend FROM friends WHERE owner = ANY($1) ORDER BY owner, friend`, friends)
		if err != nil {
			return nil, err
		}
		type pair struct{ via, u string }
		ps, _ := collect(rows, func(r pgx.Rows) (pair, error) { var p pair; return p, r.Scan(&p.via, &p.u) })
		for _, p := range ps {
			if _, ok := mutual[p.u]; !ok {
				order = append(order, p.u)
			}
			mutual[p.u] = append(mutual[p.u], p.via)
		}
	}
	for _, u := range order {
		via := mutual[u]
		reason := "friends with " + via[0]
		if len(via) > 1 {
			reason = fmt.Sprintf("%d mutual friends", len(via))
		}
		add(u, 3*len(via), reason)
	}
	// active in the same rooms (14 days)
	since := daysAgo(14)
	rows, err = s.db.Query(ctx, `SELECT DISTINCT o.room, o.uname FROM user_rooms m JOIN user_rooms o ON o.room = m.room
		WHERE m.uname = $1 AND m.day >= $2 AND o.day >= $2 ORDER BY o.room, o.uname`, me, since)
	if err != nil {
		return nil, err
	}
	type ru struct{ room, u string }
	rus, _ := collect(rows, func(r pgx.Rows) (ru, error) { var x ru; return x, r.Scan(&x.room, &x.u) })
	for _, x := range rus {
		add(x.u, 2, "active in "+x.room)
	}
	// nearby timezone
	if len(score) > 0 {
		users := []string{me}
		for u := range score {
			users = append(users, u)
		}
		tzs, err := s.userTz(ctx, users)
		if err == nil {
			if mine, ok := tzs[me]; ok {
				for u := range score {
					if t, ok := tzs[u]; ok && tzDistance(mine.Offset, t.Offset) <= 120 {
						score[u]++
						why[u] = append(why[u], "nearby timezone")
					}
				}
			}
		}
	}
	ranked := make([]string, 0, len(score))
	for u := range score {
		ranked = append(ranked, u)
	}
	sort.Slice(ranked, func(i, j int) bool {
		if score[ranked[i]] != score[ranked[j]] {
			return score[ranked[i]] > score[ranked[j]]
		}
		return ranked[i] < ranked[j]
	})
	if len(ranked) > 8 {
		ranked = ranked[:8]
	}
	out := []obj{}
	for _, u := range ranked {
		r := why[u]
		if len(r) > 3 {
			r = r[:3]
		}
		out = append(out, obj{"nick": u, "reasons": r})
	}
	return obj{"suggestions": out}, nil
}

// ---- private notes about people ----

func (s *server) getNotes(q *req) (any, error) {
	rows, err := s.db.Query(q.r.Context(), `SELECT about, text FROM notes WHERE owner = $1`, q.me)
	if err != nil {
		return nil, err
	}
	out := obj{}
	type note struct{ a, t string }
	ns, err := collect(rows, func(r pgx.Rows) (note, error) { var n note; return n, r.Scan(&n.a, &n.t) })
	for _, n := range ns {
		out[n.a] = n.t
	}
	return obj{"notes": out}, err
}

func (s *server) setNote(q *req) (any, error) {
	ctx := q.r.Context()
	about := q.lower("about")
	if !validID(about) {
		return nil, errBad
	}
	text := cut(strings.TrimSpace(q.raw("text")), 1000)
	var err error
	if text != "" {
		_, err = s.db.Exec(ctx, `INSERT INTO notes (owner, about, text) VALUES ($1,$2,$3)
			ON CONFLICT (owner, about) DO UPDATE SET text = excluded.text`, q.me, about, text)
	} else {
		_, err = s.db.Exec(ctx, `DELETE FROM notes WHERE owner = $1 AND about = $2`, q.me, about)
	}
	if err != nil {
		return nil, err
	}
	s.hub.push(q.me, "notes-changed", obj{})
	return obj{}, nil
}

// ---- profiles (NickServ properties; the app tells friends to reload) ----

func (s *server) tellProfileUpdated(ctx context.Context, q *req) {
	s.hub.pushMany(s.friendsOf(ctx, q.me), "profile-updated", obj{"nick": q.me})
	s.hub.push(q.me, "profile-updated", obj{"nick": q.me, "sid": q.sid})
}

func (s *server) profileUpdated(q *req) (any, error) {
	s.tellProfileUpdated(q.r.Context(), q)
	return obj{}, nil
}

// ---- typing & read receipts ----

func (s *server) typing(q *req) (any, error) {
	to := q.lower("to")
	active := q.boolean("active")
	if isRoom(to) && len(to) <= 50 { // a room: apps keep what they're in
		s.hub.pushAll("typing", obj{"from": q.me, "active": active, "room": to})
	} else if validID(to) && to != q.me {
		s.hub.push(to, "typing", obj{"from": q.me, "active": active})
	}
	return obj{}, nil
}

func (s *server) read(q *req) (any, error) {
	to := q.lower("to")
	if validID(to) && to != q.me {
		s.hub.push(to, "read", obj{"from": q.me, "time": q.intOr("time", 0)})
	}
	return obj{}, nil
}

// ---- last seen ----

func (s *server) getLastSeen(q *req) (any, error) {
	users := ids(q.query("users"), 200)
	out := obj{}
	if len(users) == 0 {
		return obj{"lastSeen": out}, nil
	}
	rows, err := s.db.Query(q.r.Context(), `SELECT uname, seen FROM last_seen WHERE uname = ANY($1)`, users)
	if err != nil {
		return nil, err
	}
	type ls struct {
		u string
		t int64
	}
	list, err := collect(rows, func(r pgx.Rows) (ls, error) { var x ls; return x, r.Scan(&x.u, &x.t) })
	if err != nil {
		return nil, err
	}
	seen := map[string]int64{}
	for _, x := range list {
		seen[x.u] = x.t
	}
	online := s.hub.onlineUsers()
	for _, u := range users {
		switch {
		case online[u]:
			out[u] = "now"
		case seen[u] != 0:
			out[u] = seen[u]
		default:
			out[u] = nil
		}
	}
	return obj{"lastSeen": out}, nil
}

var _ = time.Second
