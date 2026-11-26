package main

import (
	"context"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type server struct {
	cfg      config
	db       *pgxpool.Pool
	history  *pgxpool.Pool // Ergo's message history (read only), for search
	ergo     *ergo
	hub      *hub
	sess     *sessions
	preview  *previewer
	attempts *limiter // per IP: account creation / reset tries (hour)
	creates  *limiter // per IP: accounts created (hour)
	logins   *limiter // per IP+ID: wrong passwords (hour)
	previews *limiter // per user: link previews (minute)
	knocks   *limiter // per user+room: "ask to join" (minute)
}

func newServer(ctx context.Context, cfg config) (*server, error) {
	db, err := openDB(ctx, cfg.databaseURL)
	if err != nil {
		return nil, err
	}
	if err := migrate(ctx, db); err != nil {
		return nil, err
	}
	s := &server{
		cfg: cfg, db: db, ergo: newErgo(cfg), hub: newHub(), sess: newSessions(db), preview: newPreviewer(),
		attempts: newLimiter(time.Hour), creates: newLimiter(time.Hour), logins: newLimiter(time.Hour),
		previews: newLimiter(time.Minute), knocks: newLimiter(time.Minute),
	}
	if cfg.historyURL != "" {
		if s.history, err = openDB(ctx, cfg.historyURL); err != nil {
			log.Printf("history database unavailable (search off): %v", err)
			s.history = nil
		}
	}
	// Closing the last window = "last seen".
	s.hub.lastGone = func(user string) {
		s.db.Exec(context.Background(), `INSERT INTO last_seen (uname, seen) VALUES ($1, $2)
			ON CONFLICT (uname) DO UPDATE SET seen = excluded.seen`, user, now())
	}
	return s, nil
}

// route kinds
const (
	public   = iota // no token
	limited         // no token, counted per IP (account creation, reset)
	signedIn        // bearer token
)

type route struct {
	kind int
	fn   func(*req) (any, error)
}

func (s *server) routes() http.Handler {
	get := map[string]route{
		"/health":        {public, func(*req) (any, error) { return obj{}, nil }},
		"/friends":       {signedIn, s.getFriends},
		"/stats":         {signedIn, func(*req) (any, error) { return obj{"online": s.hub.onlineCount()}, nil }},
		"/redactions":    {signedIn, s.getRedactions},
		"/announcements": {signedIn, s.getAnnouncements},
		"/tz":            {signedIn, s.getTz},
		"/roomtz":        {signedIn, s.getRoomTz},
		"/roomevents":    {signedIn, s.getRoomEvents},
		"/event":         {signedIn, s.getEvent},
		"/roominfo":      {signedIn, s.getRoomInfo},
		"/suggestions":   {signedIn, s.getSuggestions},
		"/roomreads":     {signedIn, s.getRoomReads},
		"/notes":         {signedIn, s.getNotes},
		"/sessions":      {signedIn, s.getSessions},
		"/scheduled":     {signedIn, s.getScheduled},
		"/saved":         {signedIn, s.getSaved},
		"/trending":      {signedIn, s.getTrending},
		"/imv":           {signedIn, s.getImv},
		"/namecolors":    {signedIn, s.getNameColors},
		"/msgmeta":       {signedIn, s.getMsgMeta},
		"/poll":          {signedIn, s.getPoll},
		"/lastseen":      {signedIn, s.getLastSeen},
		"/reminders":     {signedIn, s.getReminders},
		"/reminders/due": {signedIn, s.getDueReminders},
		"/prefs":         {signedIn, s.getPrefs},
		"/users/search":  {signedIn, s.searchUsers},
		"/profile":       {signedIn, s.getProfile},
		"/canpm":         {signedIn, s.getCanPM},
		"/search":        {signedIn, s.searchMessages},
		"/welcome":       {signedIn, s.getWelcome},
	}
	post := map[string]route{
		"/register":      {limited, s.register},
		"/reset/request": {limited, s.resetRequest},
		"/reset/confirm": {limited, s.resetConfirm},
		"/email":         {public, s.email},
		"/session":       {public, s.newSession},

		"/session/end":           {signedIn, s.endSession},
		"/session/revoke":        {signedIn, s.revokeSession},
		"/session/revoke-others": {signedIn, s.revokeOthers},
		"/password":              {signedIn, s.changePassword},
		"/friends/request":       {signedIn, s.friendRequest},
		"/friends/respond":       {signedIn, s.friendRespond},
		"/friends/remove":        {signedIn, s.friendRemove},
		"/friends/move":          {signedIn, s.friendMove},
		"/friends/rename-group":  {signedIn, s.friendRenameGroup},
		"/prefs":                 {signedIn, s.setPrefs},
		"/typing":                {signedIn, s.typing},
		"/read":                  {signedIn, s.read},
		"/profile":               {signedIn, s.setProfile},
		"/profile/updated":       {signedIn, s.profileUpdated},
		"/redact":                {signedIn, s.redact},
		"/announce":              {signedIn, s.announce},
		"/react":                 {signedIn, s.react},
		"/edit":                  {signedIn, s.edit},
		"/pin":                   {signedIn, s.pin},
		"/poll/create":           {signedIn, s.createPoll},
		"/poll/vote":             {signedIn, s.vote},
		"/remind":                {signedIn, s.remind},
		"/namecolor":             {signedIn, s.setNameColor},
		"/expire":                {signedIn, s.expire},
		"/save":                  {signedIn, s.save},
		"/activity":              {signedIn, s.activity},
		"/imv":                   {signedIn, s.setImv},
		"/tz":                    {signedIn, s.setTz},
		"/active":                {signedIn, s.setActive},
		"/schedule":              {signedIn, s.schedule},
		"/scheduled/cancel":      {signedIn, s.cancelScheduled},
		"/event/create":          {signedIn, s.createEvent},
		"/event/rsvp":            {signedIn, s.rsvp},
		"/event/delete":          {signedIn, s.deleteEvent},
		"/roominfo":              {signedIn, s.setRoomInfo},
		"/roomread":              {signedIn, s.roomRead},
		"/note":                  {signedIn, s.setNote},
		"/knock":                 {signedIn, s.knock},
		"/welcome":               {signedIn, s.setWelcome},
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		path := r.URL.Path
		switch {
		case r.Method == "OPTIONS":
			cors(w)
			w.WriteHeader(204)
			return
		case r.Method == "GET" && path == "/events":
			if me := s.sess.user(r.Context(), r.URL.Query().Get("token")); me != "" {
				s.hub.serve(w, r, me)
			} else {
				writeErr(w, fail(401, "Please sign in again."))
			}
			return
		case r.Method == "GET" && (path == "/preview" || path == "/preview/img"):
			s.servePreview(w, r)
			s.logRequest(r, 200, start)
			return
		case r.Method == "GET" && strings.HasPrefix(path, "/join/"):
			s.joinPage(w, path[len("/join/"):])
			return
		}
		var rt route
		var ok bool
		if r.Method == "GET" {
			rt, ok = get[path]
		} else if r.Method == "POST" {
			rt, ok = post[path]
		}
		if !ok {
			writeJSON(w, 404, obj{"ok": false, "error": "not found"})
			return
		}
		q := &req{w: w, r: r, ip: clientIP(r), body: map[string]any{}}
		status := 200
		res, err := s.run(q, rt)
		if err != nil {
			if ae, isAE := err.(*apiError); isAE {
				status = ae.status
			} else {
				status = 500
			}
			writeErr(w, err)
		} else if res != nil {
			out := obj{"ok": true}
			switch v := res.(type) {
			case obj:
				for k, x := range v {
					out[k] = x
				}
			case created:
				status = 201
				for k, x := range v {
					out[k] = x
				}
			}
			writeJSON(w, status, out)
		}
		s.logRequest(r, status, start)
	})
}

// created marks a 201 reply.
type created obj

func (s *server) run(q *req, rt route) (any, error) {
	r := q.r
	if rt.kind == signedIn {
		auth := r.Header.Get("Authorization")
		if strings.HasPrefix(auth, "Bearer ") {
			q.token = auth[7:]
		}
		q.me = s.sess.user(r.Context(), q.token)
		if q.me == "" {
			return nil, fail(401, "Please sign in again.")
		}
		q.sid = sidOf(q.token)
	}
	if rt.kind == limited {
		if !s.attempts.take(q.ip, s.cfg.maxAttempts) {
			return nil, fail(429, "Too many tries. Please wait a while and try again.")
		}
	}
	if r.Method == "POST" {
		msg := "Bad request."
		if rt.kind != signedIn {
			msg = "Please fill in all the fields."
		}
		body, err := readBody(r, msg)
		if err != nil {
			return nil, err
		}
		q.body = body
	}
	return rt.fn(q)
}

var tokenInURL = regexp.MustCompile(`token=[^ &"]+`)

// logRequest: request line only (no bodies/passwords, never the token);
// the chatty typing and event calls only when they fail.
func (s *server) logRequest(r *http.Request, status int, start time.Time) {
	p := r.URL.Path
	if (p == "/typing" || p == "/events" || p == "/health") && status < 400 {
		return
	}
	line := tokenInURL.ReplaceAllString(r.Method+" "+r.URL.RequestURI(), "token=<redacted>")
	log.Printf("%s %s %d %s", clientIP(r), line, status, time.Since(start).Round(time.Millisecond))
}
