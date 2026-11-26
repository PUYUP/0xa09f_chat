package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	sessionTTL  = 7 * 24 * 3600 // seconds
	sessionIdle = 2 * 24 * 3600 // a device unused for 2 days is signed out
)

// Sessions live in Postgres (a restart doesn't sign anyone out); only the
// token's SHA-256 is stored. Checked tokens are cached in memory, and the
// "last used" time is written back at most once a minute.
type sessions struct {
	db    *pgxpool.Pool
	mu    sync.Mutex
	cache map[string]*session // token hash -> session
}

type session struct {
	hash, user, device     string
	created, last, expires int64
	lastSaved              int64
}

func tokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// sidOf is the short public id of a session: lets a device recognise its
// own events (same as sha256(token)[:12] in the Python service).
func sidOf(token string) string { return tokenHash(token)[:12] }

func newSessions(db *pgxpool.Pool) *sessions {
	return &sessions{db: db, cache: map[string]*session{}}
}

func (s *sessions) create(ctx context.Context, user, device string) (string, error) {
	b := make([]byte, 32)
	rand.Read(b)
	token := base64.RawURLEncoding.EncodeToString(b)
	device = cut(squash(device), 80)
	if device == "" {
		device = "Unknown device"
	}
	t := now()
	ss := &session{hash: tokenHash(token), user: user, device: device, created: t, last: t, expires: t + sessionTTL, lastSaved: t}
	if _, err := s.db.Exec(ctx, `INSERT INTO sessions (token_hash, uname, device, created, last, expires) VALUES ($1,$2,$3,$4,$5,$6)`,
		ss.hash, user, device, t, t, ss.expires); err != nil {
		return "", err
	}
	s.db.Exec(ctx, `DELETE FROM sessions WHERE expires < $1 OR last < $2`, t, t-sessionIdle)
	s.mu.Lock()
	s.cache[ss.hash] = ss
	s.mu.Unlock()
	return token, nil
}

// user returns who a token belongs to ("" = not signed in).
func (s *sessions) user(ctx context.Context, token string) string {
	if token == "" {
		return ""
	}
	h := tokenHash(token)
	t := now()
	s.mu.Lock()
	ss := s.cache[h]
	s.mu.Unlock()
	if ss == nil {
		var x session
		err := s.db.QueryRow(ctx, `SELECT uname, device, created, last, expires FROM sessions WHERE token_hash = $1`, h).
			Scan(&x.user, &x.device, &x.created, &x.last, &x.expires)
		if err != nil {
			return ""
		}
		x.hash, x.lastSaved = h, x.last
		ss = &x
		s.mu.Lock()
		s.cache[h] = ss
		s.mu.Unlock()
	}
	s.mu.Lock()
	expired := ss.expires < t || t-ss.last > sessionIdle
	if !expired {
		ss.last = t
	}
	save := !expired && t-ss.lastSaved >= 60
	if save {
		ss.lastSaved = t
	}
	user := ss.user
	s.mu.Unlock()
	if expired {
		s.drop(ctx, []string{h})
		return ""
	}
	if save {
		s.db.Exec(ctx, `UPDATE sessions SET last = $1 WHERE token_hash = $2`, t, h)
	}
	return user
}

func (s *sessions) drop(ctx context.Context, hashes []string) {
	if len(hashes) == 0 {
		return
	}
	s.mu.Lock()
	for _, h := range hashes {
		delete(s.cache, h)
	}
	s.mu.Unlock()
	s.db.Exec(ctx, `DELETE FROM sessions WHERE token_hash = ANY($1)`, hashes)
}

func (s *sessions) end(ctx context.Context, token string) { s.drop(ctx, []string{tokenHash(token)}) }

// endUser signs out every device of user except keepToken.
func (s *sessions) endUser(ctx context.Context, user, keepToken string) {
	keep := ""
	if keepToken != "" {
		keep = tokenHash(keepToken)
	}
	rows, err := s.db.Query(ctx, `SELECT token_hash FROM sessions WHERE uname = $1`, user)
	if err != nil {
		return
	}
	hs, _ := collect(rows, func(r pgxRows) (string, error) { var h string; return h, r.Scan(&h) })
	var drop []string
	for _, h := range hs {
		if h != keep {
			drop = append(drop, h)
		}
	}
	s.drop(ctx, drop)
}

type deviceInfo struct {
	Sid     string `json:"sid"`
	Current bool   `json:"current"`
	Device  string `json:"device"`
	Created int64  `json:"created"`
	Last    int64  `json:"last"`
}

// list: this account's signed-in devices, most recently used first.
func (s *sessions) list(ctx context.Context, user, currentToken string) ([]deviceInfo, error) {
	cur := tokenHash(currentToken)
	t := now()
	rows, err := s.db.Query(ctx, `SELECT token_hash, device, created, last FROM sessions
		WHERE uname = $1 AND expires > $2 AND last >= $3`, user, t, t-sessionIdle)
	if err != nil {
		return nil, err
	}
	out, err := collect(rows, func(r pgxRows) (deviceInfo, error) {
		var h string
		var d deviceInfo
		err := r.Scan(&h, &d.Device, &d.Created, &d.Last)
		d.Sid, d.Current = h[:12], h == cur
		return d, err
	})
	if err != nil {
		return nil, err
	}
	// The cache knows fresher "last" times than the table.
	s.mu.Lock()
	for i := range out {
		for h, ss := range s.cache {
			if h[:12] == out[i].Sid && ss.user == user {
				out[i].Last = ss.last
			}
		}
	}
	s.mu.Unlock()
	sortSlice(out, func(a, b deviceInfo) bool { return a.Last > b.Last })
	return out, nil
}

// revoke signs one device out by its sid.
func (s *sessions) revoke(ctx context.Context, user, sid string) bool {
	if len(sid) != 12 {
		return false
	}
	rows, err := s.db.Query(ctx, `SELECT token_hash FROM sessions WHERE uname = $1 AND left(token_hash, 12) = $2`, user, sid)
	if err != nil {
		return false
	}
	hs, _ := collect(rows, func(r pgxRows) (string, error) { var h string; return h, r.Scan(&h) })
	s.drop(ctx, hs)
	return len(hs) > 0
}

// sweep forgets cached sessions not used for a while.
func (s *sessions) sweep() {
	t := now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for h, ss := range s.cache {
		if t-ss.last > 3600 {
			delete(s.cache, h)
		}
	}
}
