package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// apiError is an error the person sees (a sentence), with its HTTP status.
type apiError struct {
	status int
	msg    string
}

func (e *apiError) Error() string { return e.msg }

func fail(status int, msg string) error { return &apiError{status, msg} }

var errBad = fail(400, "Bad request.")

// obj is a JSON object reply; "ok": true is added.
type obj = map[string]any

// req is one API call.
type req struct {
	w     http.ResponseWriter
	r     *http.Request
	ip    string
	me    string // signed-in user ("" for public routes)
	token string
	sid   string
	body  map[string]any
}

func (q *req) query(k string) string { return q.r.URL.Query().Get(k) }

// ---- body values (loosely typed, like the Python service) ----

func (q *req) has(k string) bool { _, ok := q.body[k]; return ok }

// str is the value as text, trimmed ("" when missing or null).
func (q *req) str(k string) string { return strings.TrimSpace(toStr(q.body[k])) }

// raw is the value as text, untrimmed.
func (q *req) raw(k string) string { return toStr(q.body[k]) }

func (q *req) lower(k string) string { return strings.ToLower(q.str(k)) }

func (q *req) boolean(k string) bool { return truthy(q.body[k]) }

// integer parses the value; ok is false when it is missing or not a number.
func (q *req) integer(k string) (int64, bool) { return toInt(q.body[k]) }

// intOr is integer with a default for missing/invalid values.
func (q *req) intOr(k string, def int64) int64 {
	if n, ok := q.integer(k); ok {
		return n
	}
	return def
}

func toStr(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case json.Number:
		return x.String()
	case bool:
		if x {
			return "True"
		}
		return "False"
	default:
		b, _ := json.Marshal(x)
		return string(b)
	}
}

func toInt(v any) (int64, bool) {
	switch x := v.(type) {
	case json.Number:
		if n, err := x.Int64(); err == nil {
			return n, true
		}
		if f, err := x.Float64(); err == nil && !math.IsInf(f, 0) && !math.IsNaN(f) {
			return int64(f), true
		}
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(x), 10, 64); err == nil {
			return n, true
		}
	case float64:
		return int64(x), true
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil
	case float64:
		return x, true
	}
	return 0, false
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		f, _ := x.Float64()
		return f != 0
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true
}

// ---- validation shared by many routes ----

var (
	usernameRe = regexp.MustCompile(`^[a-z][a-z0-9_-]{2,15}$`)
	hashRe     = regexp.MustCompile(`^[0-9a-z]{1,16}$`)
	badRoomRe  = regexp.MustCompile(`[\s,\x00-\x1f]`)
)

func validID(u string) bool { return usernameRe.MatchString(u) }

func isRoom(t string) bool { return strings.HasPrefix(t, "#") || strings.HasPrefix(t, "&") }

// roomOK: a room name that's safe to store and to put in an IRC line.
func roomOK(r string) bool { return isRoom(r) && len(r) <= 50 && !badRoomRe.MatchString(r) }

func isConference(r string) bool { return strings.HasPrefix(r, "#conf-") }

// ids splits "a,b,c" and keeps valid IDs.
func ids(s string, max int) []string {
	var out []string
	for _, u := range strings.Split(strings.ToLower(s), ",") {
		if validID(u) {
			out = append(out, u)
		}
		if len(out) >= max {
			break
		}
	}
	return out
}

func rooms(s string, max int) []string {
	var out []string
	for _, r := range strings.Split(strings.ToLower(s), ",") {
		if isRoom(r) && len(r) <= 50 {
			out = append(out, r)
		}
		if len(out) >= max {
			break
		}
	}
	return out
}

// squash collapses whitespace runs and trims, like " ".join(s.split()).
func squash(s string) string { return strings.Join(strings.Fields(s), " ") }

// cut keeps at most n characters (runes).
func cut(s string, n int) string {
	if n < 0 {
		return ""
	}
	i := 0
	for p := range s {
		if i == n {
			return s[:p]
		}
		i++
	}
	return s
}

// oneLine strips CR/LF (text that ends up in an IRC line).
func oneLine(s string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(s)
}

// ---- writing replies ----

func cors(w http.ResponseWriter) {
	// Called from the desktop app's webview (tauri:// / http://tauri.localhost).
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	data, err := json.Marshal(body)
	if err != nil {
		status, data = 500, []byte(`{"ok":false,"error":"Something went wrong. Please try again later."}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	cors(w)
	w.WriteHeader(status)
	w.Write(data)
}

func writeErr(w http.ResponseWriter, err error) {
	var ae *apiError
	if errors.As(err, &ae) {
		writeJSON(w, ae.status, obj{"ok": false, "error": ae.msg})
		return
	}
	log.Printf("error: %v", err) // never leak internals to the client
	writeJSON(w, 500, obj{"ok": false, "error": "Something went wrong. Please try again later."})
}

// readBody decodes a small JSON object.
func readBody(r *http.Request, badMsg string) (map[string]any, error) {
	if r.ContentLength <= 0 || r.ContentLength > 4096 {
		return nil, fail(400, badMsg)
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 4097))
	if err != nil || len(data) > 4096 {
		return nil, fail(400, badMsg)
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.UseNumber()
	var body map[string]any
	if err := dec.Decode(&body); err != nil || body == nil {
		return nil, fail(400, badMsg)
	}
	return body, nil
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---- sliding-window rate limits (in memory) ----

type limiter struct {
	mu     sync.Mutex
	window time.Duration
	hits   map[string][]time.Time
}

func newLimiter(window time.Duration) *limiter {
	return &limiter{window: window, hits: map[string][]time.Time{}}
}

func (l *limiter) prune(key string, now time.Time) []time.Time {
	q := l.hits[key]
	i := 0
	for i < len(q) && now.Sub(q[i]) > l.window {
		i++
	}
	q = q[i:]
	if len(q) == 0 {
		delete(l.hits, key)
	} else {
		l.hits[key] = q
	}
	return q
}

func (l *limiter) over(key string, limit int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.prune(key, time.Now())) >= limit
}

func (l *limiter) add(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	l.hits[key] = append(l.prune(key, now), now)
}

// take adds a hit unless the key is already at the limit.
func (l *limiter) take(key string, limit int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	q := l.prune(key, now)
	if len(q) >= limit {
		return false
	}
	l.hits[key] = append(q, now)
	return true
}

// sweep drops old keys (called from the background loop).
func (l *limiter) sweep() {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	for k := range l.hits {
		l.prune(k, now)
	}
}

func plural(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}
