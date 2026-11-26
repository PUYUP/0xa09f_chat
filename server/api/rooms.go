package main

import (
	"context"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ---- name colors ----

// Readable on the white chat background; the app shows the same palette.
var nameColors = map[string]bool{"#c0392b": true, "#d35400": true, "#b7950b": true, "#27ae60": true, "#16a085": true,
	"#2980b9": true, "#1f3a93": true, "#8e44ad": true, "#c2185b": true, "#6d4c41": true, "#546e7a": true, "#000000": true}

func (s *server) setNameColor(q *req) (any, error) {
	ctx := q.r.Context()
	var color any
	if c := strings.ToLower(q.raw("color")); c == "" {
		if _, err := s.db.Exec(ctx, `DELETE FROM name_colors WHERE uname = $1`, q.me); err != nil {
			return nil, err
		}
	} else {
		if !nameColors[c] {
			return nil, fail(400, "That color isn't available.")
		}
		if _, err := s.db.Exec(ctx, `INSERT INTO name_colors VALUES ($1,$2) ON CONFLICT (uname) DO UPDATE SET color = excluded.color`,
			q.me, c); err != nil {
			return nil, err
		}
		color = c
	}
	s.hub.pushAll("namecolor", obj{"user": q.me, "color": color})
	return obj{}, nil
}

func (s *server) getNameColors(q *req) (any, error) {
	users := ids(q.query("users"), 300)
	out := obj{}
	if len(users) > 0 {
		rows, err := s.db.Query(q.r.Context(), `SELECT uname, color FROM name_colors WHERE uname = ANY($1)`, users)
		if err != nil {
			return nil, err
		}
		type uc struct{ u, c string }
		list, err := collect(rows, func(r pgx.Rows) (uc, error) { var x uc; return x, r.Scan(&x.u, &x.c) })
		if err != nil {
			return nil, err
		}
		for _, x := range list {
			out[x.u] = x.c
		}
	}
	return obj{"colors": out}, nil
}

// ---- IMVironments (themes for private chats) ----

var imvThemes = map[string]bool{"none": true, "beach": true, "night": true, "rain": true, "love": true, "space": true,
	"forest": true, "snow": true, "sunset": true}

func pairKey(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return a + "|" + b
}

func (s *server) setImv(q *req) (any, error) {
	ctx := q.r.Context()
	other := q.lower("with")
	if !validID(other) || other == q.me {
		return nil, errBad
	}
	theme := q.raw("theme")
	if !imvThemes[theme] {
		return nil, fail(400, "That theme isn't available.")
	}
	var err error
	if theme == "none" {
		_, err = s.db.Exec(ctx, `DELETE FROM imv WHERE pair = $1`, pairKey(q.me, other))
	} else {
		_, err = s.db.Exec(ctx, `INSERT INTO imv VALUES ($1,$2,$3) ON CONFLICT (pair) DO UPDATE SET theme = excluded.theme,
			by_user = excluded.by_user`, pairKey(q.me, other), theme, q.me)
	}
	if err != nil {
		return nil, err
	}
	s.hub.pushMany([]string{q.me, other}, "imv", obj{"a": q.me, "b": other, "theme": theme, "by": q.me})
	return obj{}, nil
}

func (s *server) getImv(q *req) (any, error) {
	other := strings.ToLower(q.query("with"))
	if !validID(other) {
		return nil, errBad
	}
	var theme, by string
	if s.db.QueryRow(q.r.Context(), `SELECT theme, by_user FROM imv WHERE pair = $1`, pairKey(q.me, other)).Scan(&theme, &by) != nil {
		return obj{"theme": "none", "by": nil}, nil
	}
	return obj{"theme": theme, "by": by}, nil
}

// ---- timezones & active hours ----

type tzInfo struct {
	Tz     string `json:"tz"`
	Offset int    `json:"offset"`
	Active []int  `json:"active,omitempty"`
}

func (s *server) userTz(ctx context.Context, users []string) (map[string]tzInfo, error) {
	if len(users) > 300 {
		users = users[:300]
	}
	out := map[string]tzInfo{}
	if len(users) == 0 {
		return out, nil
	}
	rows, err := s.db.Query(ctx, `SELECT t.uname, t.tz, t.utc_offset, a.start_min, a.end_min FROM user_tz t
		LEFT JOIN user_active a ON a.uname = t.uname WHERE t.uname = ANY($1)`, users)
	if err != nil {
		return nil, err
	}
	type row struct {
		u, tz      string
		off        int
		start, end *int
	}
	list, err := collect(rows, func(r pgx.Rows) (row, error) { var x row; return x, r.Scan(&x.u, &x.tz, &x.off, &x.start, &x.end) })
	if err != nil {
		return nil, err
	}
	for _, x := range list {
		t := tzInfo{Tz: x.tz, Offset: x.off}
		if x.start != nil && x.end != nil {
			t.Active = []int{*x.start, *x.end}
		}
		out[x.u] = t
	}
	return out, nil
}

func (s *server) getTz(q *req) (any, error) {
	tz, err := s.userTz(q.r.Context(), ids(q.query("users"), 300))
	return obj{"tz": tz}, err
}

func (s *server) setTz(q *req) (any, error) {
	tz := cut(q.raw("tz"), 64)
	off, ok := q.integer("offset")
	if !q.has("offset") {
		off, ok = 0, true
	}
	if !ok || off < -720 || off > 840 {
		return nil, fail(400, "Bad timezone.")
	}
	_, err := s.db.Exec(q.r.Context(), `INSERT INTO user_tz VALUES ($1,$2,$3,$4) ON CONFLICT (uname) DO UPDATE SET
		tz = excluded.tz, utc_offset = excluded.utc_offset, updated = excluded.updated`, q.me, tz, off, now())
	return obj{}, err
}

// POST /active {"start","end"}: active hours in my local time (minutes after
// midnight); null clears them (= always fine to message).
func (s *server) setActive(q *req) (any, error) {
	ctx := q.r.Context()
	if q.body["start"] == nil || q.body["end"] == nil {
		if _, err := s.db.Exec(ctx, `DELETE FROM user_active WHERE uname = $1`, q.me); err != nil {
			return nil, err
		}
	} else {
		start, ok1 := q.integer("start")
		end, ok2 := q.integer("end")
		if !ok1 || !ok2 {
			return nil, errBad
		}
		if start < 0 || start >= 1440 || end < 0 || end >= 1440 || start == end {
			return nil, fail(400, "Pick a start and an end time.")
		}
		if _, err := s.db.Exec(ctx, `INSERT INTO user_active VALUES ($1,$2,$3) ON CONFLICT (uname) DO UPDATE SET
			start_min = excluded.start_min, end_min = excluded.end_min`, q.me, start, end); err != nil {
			return nil, err
		}
	}
	s.hub.pushAll("active-changed", obj{"user": q.me})
	return obj{}, nil
}

// ---- room activity: trending, room timezone, "people in your rooms" ----

func (s *server) activity(q *req) (any, error) {
	ctx := q.r.Context()
	room := q.lower("room")
	if !isRoom(room) || len(room) > 50 || isConference(room) {
		return obj{}, nil
	}
	day := today()
	b := &pgx.Batch{}
	b.Queue(`INSERT INTO room_activity VALUES ($1,$2,1) ON CONFLICT (room, day) DO UPDATE SET msgs = room_activity.msgs + 1`, room, day)
	b.Queue(`INSERT INTO room_tz (room, day, utc_offset, msgs) SELECT $1, $2, utc_offset, 1 FROM user_tz WHERE uname = $3
		ON CONFLICT (room, day, utc_offset) DO UPDATE SET msgs = room_tz.msgs + 1`, room, day, q.me)
	b.Queue(`INSERT INTO user_rooms VALUES ($1,$2,$3,1) ON CONFLICT (uname, room, day) DO UPDATE SET msgs = user_rooms.msgs + 1`,
		q.me, room, day)
	if err := s.db.SendBatch(ctx, b).Close(); err != nil {
		return nil, err
	}
	return obj{}, nil
}

func (s *server) getTrending(q *req) (any, error) {
	rows, err := s.db.Query(q.r.Context(), `SELECT room, msgs FROM room_activity WHERE day = $1 ORDER BY msgs DESC, room LIMIT 8`, today())
	if err != nil {
		return nil, err
	}
	out, err := collect(rows, func(r pgx.Rows) (obj, error) {
		var room string
		var n int
		err := r.Scan(&room, &n)
		return obj{"room": room, "msgs": n}, err
	})
	return obj{"trending": out}, err
}

// GET /roomtz?rooms=: a room's typical UTC offset — the message-weighted
// median of the senders' offsets over the last 7 days (null when unknown).
func (s *server) getRoomTz(q *req) (any, error) {
	list := rooms(q.query("rooms"), 200)
	out := obj{}
	if len(list) == 0 {
		return obj{"tz": out}, nil
	}
	rows, err := s.db.Query(q.r.Context(), `SELECT room, utc_offset, SUM(msgs) FROM room_tz WHERE room = ANY($1) AND day >= $2
		GROUP BY room, utc_offset ORDER BY room, utc_offset`, list, daysAgo(7))
	if err != nil {
		return nil, err
	}
	type ro struct {
		room string
		off  int
		n    int64
	}
	data, err := collect(rows, func(r pgx.Rows) (ro, error) { var x ro; return x, r.Scan(&x.room, &x.off, &x.n) })
	if err != nil {
		return nil, err
	}
	by := map[string][]ro{}
	for _, x := range data {
		by[x.room] = append(by[x.room], x)
	}
	for _, room := range list {
		out[room] = nil
		var total int64
		for _, x := range by[room] {
			total += x.n
		}
		var acc int64
		for _, x := range by[room] {
			acc += x.n
			if acc*2 >= total {
				out[room] = x.off
				break
			}
		}
	}
	return obj{"tz": out}, nil
}

// ---- room events with RSVP ----

var rsvpStates = map[string]bool{"going": true, "maybe": true, "no": true}

func roomFromBody(q *req) (string, error) {
	room := q.lower("room")
	if !roomOK(room) {
		return "", fail(400, "Bad room.")
	}
	return room, nil
}

func (s *server) createEvent(q *req) (any, error) {
	ctx := q.r.Context()
	room, err := roomFromBody(q)
	if err != nil {
		return nil, err
	}
	title := cut(squash(q.raw("title")), 120)
	start, ok := q.integer("start")
	if !q.has("start") {
		start, ok = 0, true
	}
	if !ok {
		return nil, errBad
	}
	t := now()
	if title == "" {
		return nil, fail(400, "Give the event a name.")
	}
	if start < t+60 || start > t+365*86400 {
		return nil, fail(400, "Pick a time in the future (up to a year ahead).")
	}
	var n int
	s.db.QueryRow(ctx, `SELECT COUNT(*) FROM events WHERE room = $1 AND start > $2`, room, t).Scan(&n)
	if n >= 20 {
		return nil, fail(409, "This room already has 20 upcoming events.")
	}
	var id int64
	if err := s.db.QueryRow(ctx, `INSERT INTO events (room, creator, title, start, created) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		room, q.me, title, start, t).Scan(&id); err != nil {
		return nil, err
	}
	s.db.Exec(ctx, `INSERT INTO rsvps VALUES ($1,$2,'going') ON CONFLICT (event, uname) DO UPDATE SET status = 'going'`, id, q.me)
	s.hub.pushAll("event", obj{"id": id, "room": room})
	return obj{"id": id}, nil
}

func (s *server) eventState(ctx context.Context, me string, id int64) (obj, error) {
	var room, creator, title string
	var start int64
	if err := s.db.QueryRow(ctx, `SELECT room, creator, title, start FROM events WHERE id = $1`, id).Scan(&room, &creator, &title, &start); err != nil {
		if noRows(err) {
			return nil, fail(404, "That event isn't there any more.")
		}
		return nil, err
	}
	people := map[string][]string{"going": {}, "maybe": {}, "no": {}}
	var mine any
	rows, err := s.db.Query(ctx, `SELECT uname, status FROM rsvps WHERE event = $1 ORDER BY uname`, id)
	if err != nil {
		return nil, err
	}
	type us struct{ u, st string }
	list, err := collect(rows, func(r pgx.Rows) (us, error) { var x us; return x, r.Scan(&x.u, &x.st) })
	if err != nil {
		return nil, err
	}
	for _, x := range list {
		people[x.st] = append(people[x.st], x.u)
		if x.u == me {
			mine = x.st
		}
	}
	return obj{"id": id, "room": room, "creator": creator, "title": title, "start": start, "people": people, "mine": mine}, nil
}

func (s *server) getEvent(q *req) (any, error) {
	var id int64
	if _, err := fmt.Sscan(q.query("id"), &id); err != nil && q.query("id") != "" {
		return nil, errBad
	}
	return s.eventState(q.r.Context(), q.me, id)
}

func (s *server) getRoomEvents(q *req) (any, error) {
	ctx := q.r.Context()
	rows, err := s.db.Query(ctx, `SELECT id FROM events WHERE room = $1 AND start > $2 ORDER BY start LIMIT 20`,
		strings.ToLower(q.query("room")), now()-3*3600)
	if err != nil {
		return nil, err
	}
	idList, err := collect(rows, func(r pgx.Rows) (int64, error) { var id int64; return id, r.Scan(&id) })
	if err != nil {
		return nil, err
	}
	out := []obj{}
	for _, id := range idList {
		ev, err := s.eventState(ctx, q.me, id)
		if err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	return obj{"events": out}, nil
}

func (s *server) rsvp(q *req) (any, error) {
	ctx := q.r.Context()
	ev, err := s.eventState(ctx, q.me, q.intOr("id", 0))
	if err != nil {
		return nil, err
	}
	id := ev["id"]
	if q.body["status"] == nil {
		_, err = s.db.Exec(ctx, `DELETE FROM rsvps WHERE event = $1 AND uname = $2`, id, q.me)
	} else if st := toStr(q.body["status"]); rsvpStates[st] {
		_, err = s.db.Exec(ctx, `INSERT INTO rsvps VALUES ($1,$2,$3) ON CONFLICT (event, uname) DO UPDATE SET status = excluded.status`,
			id, q.me, st)
	} else {
		return nil, fail(400, "Bad answer.")
	}
	if err != nil {
		return nil, err
	}
	s.hub.pushAll("event", obj{"id": id, "room": ev["room"]})
	return obj{}, nil
}

func (s *server) deleteEvent(q *req) (any, error) {
	ctx := q.r.Context()
	ev, err := s.eventState(ctx, q.me, q.intOr("id", 0))
	if err != nil {
		return nil, err
	}
	if ev["creator"] != q.me {
		return nil, fail(403, "Only the person who created the event can cancel it.")
	}
	s.db.Exec(ctx, `DELETE FROM rsvps WHERE event = $1`, ev["id"])
	if _, err := s.db.Exec(ctx, `DELETE FROM events WHERE id = $1`, ev["id"]); err != nil {
		return nil, err
	}
	s.hub.pushAll("event", obj{"id": ev["id"], "room": ev["room"], "deleted": true})
	return obj{}, nil
}

// eventsStarting: events starting within 15 minutes nobody was told about yet.
func (s *server) eventsStarting(ctx context.Context) {
	t := now()
	rows, err := s.db.Query(ctx, `UPDATE events SET notified = TRUE WHERE NOT notified AND start <= $1 AND start > $2
		RETURNING id, room, title, start`, t+15*60, t-60)
	if err != nil {
		return
	}
	evs, _ := collect(rows, func(r pgx.Rows) (obj, error) {
		var id, start int64
		var room, title string
		err := r.Scan(&id, &room, &title, &start)
		return obj{"id": id, "room": room, "title": title, "start": start}, err
	})
	for _, ev := range evs {
		rows, err := s.db.Query(ctx, `SELECT uname FROM rsvps WHERE event = $1 AND status IN ('going','maybe') ORDER BY uname`, ev["id"])
		if err != nil {
			continue
		}
		users, _ := collect(rows, func(r pgx.Rows) (string, error) { var u string; return u, r.Scan(&u) })
		ev["users"] = users
		s.hub.pushMany(users, "event-soon", ev)
	}
}

// ---- room category & language ----

var (
	categories = map[string]bool{"general": true, "games": true, "music": true, "tech": true, "sports": true, "study": true,
		"movies": true, "hangout": true, "other": true}
	langs = map[string]bool{"": true, "id": true, "en": true, "ms": true, "jv": true, "su": true, "ja": true, "ko": true,
		"zh": true, "es": true, "fr": true, "de": true, "ar": true, "other": true}
)

func (s *server) setRoomInfo(q *req) (any, error) {
	room, err := roomFromBody(q)
	if err != nil {
		return nil, err
	}
	category := strings.ToLower(q.raw("category"))
	if category == "" {
		category = "general"
	}
	lang := strings.ToLower(q.raw("lang"))
	if !categories[category] || !langs[lang] {
		return nil, fail(400, "Unknown category or language.")
	}
	if _, err := s.db.Exec(q.r.Context(), `INSERT INTO room_info VALUES ($1,$2,$3,$4) ON CONFLICT (room) DO UPDATE SET
		category = excluded.category, lang = excluded.lang, set_by = excluded.set_by`, room, category, lang, q.me); err != nil {
		return nil, err
	}
	s.hub.pushAll("roominfo", obj{"room": room})
	return obj{}, nil
}

func (s *server) getRoomInfo(q *req) (any, error) {
	list := rooms(q.query("rooms"), 300)
	out := obj{}
	if len(list) > 0 {
		rows, err := s.db.Query(q.r.Context(), `SELECT room, category, lang FROM room_info WHERE room = ANY($1)`, list)
		if err != nil {
			return nil, err
		}
		type ri struct{ r, c, l string }
		data, err := collect(rows, func(r pgx.Rows) (ri, error) { var x ri; return x, r.Scan(&x.r, &x.c, &x.l) })
		if err != nil {
			return nil, err
		}
		for _, x := range data {
			out[x.r] = obj{"category": x.c, "lang": x.l}
		}
	}
	return obj{"info": out}, nil
}

// ---- "seen by" in rooms ----

func (s *server) roomRead(q *req) (any, error) {
	room := q.lower("room")
	if !roomOK(room) || isConference(room) {
		return obj{}, nil
	}
	t := q.intOr("time", 0)
	if _, err := s.db.Exec(q.r.Context(), `INSERT INTO room_reads VALUES ($1,$2,$3) ON CONFLICT (room, uname) DO UPDATE SET
		msg_time = GREATEST(room_reads.msg_time, excluded.msg_time)`, room, q.me, t); err != nil {
		return nil, err
	}
	s.hub.pushAll("room-read", obj{"room": room, "user": q.me, "time": t})
	return obj{}, nil
}

func (s *server) getRoomReads(q *req) (any, error) {
	rows, err := s.db.Query(q.r.Context(), `SELECT uname, msg_time FROM room_reads WHERE room = $1`, strings.ToLower(q.query("room")))
	if err != nil {
		return nil, err
	}
	type ut struct {
		u string
		t int64
	}
	list, err := collect(rows, func(r pgx.Rows) (ut, error) { var x ut; return x, r.Scan(&x.u, &x.t) })
	out := obj{}
	for _, x := range list {
		out[x.u] = x.t
	}
	return obj{"reads": out}, err
}

// ---- public invite page ----

var joinRoomRe = regexp.MustCompile(`^[^\s,#&\x00-\x1f/<>"'\\]{1,49}$`)

// GET /join/<room>: works in any browser, opens the app if installed.
func (s *server) joinPage(w http.ResponseWriter, raw string) {
	room, err := url.PathUnescape(raw)
	room = strings.TrimLeft(strings.TrimSpace(room), "#")
	if err != nil || !joinRoomRe.MatchString(room) {
		writeJSON(w, 404, obj{"ok": false, "error": "not found"})
		return
	}
	esc := html.EscapeString(room)
	page := `<!doctype html><html><head><meta charset="utf-8"><title>Join #` + esc + ` on a09f</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:Verdana,sans-serif;background:#f3edfb;display:flex;justify-content:center;padding-top:12vh;margin:0}
.card{background:#fff;border:1px solid #c9b8ec;border-radius:10px;padding:28px 36px;text-align:center;max-width:380px}
h1{color:#5b2a8c;margin:0 0 6px}a.btn{display:inline-block;margin-top:18px;background:#6a3aa2;color:#fff;padding:10px 22px;
border-radius:6px;text-decoration:none;font-weight:bold}p{color:#555;font-size:13px}code{background:#f6f2fb;padding:2px 6px}</style>
</head><body><div class="card"><h1>a09f</h1><p>You're invited to the chat room</p><h2>#` + esc + `</h2>
<a class="btn" href="a09f://join/` + esc + `">Open in a09f</a>
<p>Don't have the app open? Start a09f and type <code>` + esc + `</code> in the Join box,<br>or press Ctrl/Cmd+K and paste this link.</p>
</div></body></html>`
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	w.WriteHeader(200)
	w.Write([]byte(page))
}

var _ = sort.Strings
