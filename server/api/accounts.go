package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"log"
	"math/big"
	"regexp"
	"strings"
	"unicode"
)

const (
	resetCodeTTL  = 15 * 60 // seconds a reset code stays valid
	resetMaxTries = 5       // wrong codes before it's burned
	resetCooldown = 60      // seconds between codes for one account
	minPassword   = 8
	maxPassword   = 128
)

var (
	reserved = map[string]bool{
		"admin": true, "root": true, "administrator": true, "operator": true, "oper": true, "system": true,
		"server": true, "a09f": true, "help": true, "support": true, "staff": true,
		"soju": true, "solanum": true, "atheme": true,
	}
	emailRe = regexp.MustCompile(`^[^@\s<>"',;]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$`)
)

func validateID(u string) error {
	if !validID(u) {
		return fail(400, "ID must be 3–16 characters: lowercase letters, numbers, - or _, and start with a letter.")
	}
	if reserved[u] || strings.HasSuffix(u, "serv") {
		return fail(409, "That ID isn't available. Please choose another.")
	}
	return nil
}

func validatePassword(p string) error {
	n := len([]rune(p))
	if n < minPassword || n > maxPassword {
		return fail(400, fmt.Sprintf("Password must be at least %d characters.", minPassword))
	}
	for _, c := range p {
		if c < 0x20 || c == 0x7f {
			return fail(400, "Password contains characters that aren't allowed.")
		}
	}
	for _, c := range p {
		if unicode.IsSpace(c) {
			return fail(400, "Password can't contain spaces.")
		}
	}
	return nil
}

func validateEmail(e string) (string, error) {
	if len(e) > 254 || !emailRe.MatchString(e) {
		return "", fail(400, "Please enter a valid email address.")
	}
	return e, nil
}

func maskEmail(e string) string {
	local, domain, _ := strings.Cut(e, "@")
	if local == "" {
		return "***@" + domain
	}
	return string([]rune(local)[:1]) + "***@" + domain
}

func codeHash(user, code string) string {
	h := sha256.Sum256([]byte(user + ":" + code))
	return hex.EncodeToString(h[:])
}

func (s *server) getEmail(ctx context.Context, user string) string {
	var e string
	s.db.QueryRow(ctx, `SELECT email FROM emails WHERE uname = $1`, user).Scan(&e)
	return e
}

func (s *server) setEmail(ctx context.Context, user, email string) error {
	_, err := s.db.Exec(ctx, `INSERT INTO emails (uname, email, updated) VALUES ($1, $2, $3)
		ON CONFLICT (uname) DO UPDATE SET email = excluded.email, updated = excluded.updated`, user, email, now())
	return err
}

// passwordOK checks a password; wrong ones are limited per IP + ID (never a
// budget shared by everyone behind one address).
func (s *server) passwordOK(q *req, user, password string) error {
	key := q.ip + "|" + user
	if s.logins.over(key, s.cfg.maxLoginFail) {
		return fail(429, "Too many wrong passwords. Please wait a while and try again.")
	}
	if validID(user) {
		ok, err := s.bouncer.checkAuth(q.r.Context(), user, password)
		if err != nil {
			log.Printf("login check error: %v", err)
			return fail(503, "Can't check your password right now. Please try again later.")
		}
		if ok {
			return nil
		}
	}
	s.logins.add(key)
	return fail(403, "Your password isn't right.")
}

// ---- POST /register {"username","password","email"} -> 201 ----

func (s *server) register(q *req) (any, error) {
	ctx := q.r.Context()
	if s.creates.over(q.ip, s.cfg.maxCreates) {
		return nil, fail(429, "Too many tries. Please wait a while and try again.")
	}
	user := q.lower("username")
	password := q.raw("password")
	if err := validateID(user); err != nil {
		return nil, err
	}
	if err := validatePassword(password); err != nil {
		return nil, err
	}
	email, err := validateEmail(q.str("email"))
	if err != nil {
		return nil, err
	}
	if err := s.createAccount(ctx, user, password); err != nil {
		return nil, err
	}
	if err := s.setEmail(ctx, user, email); err != nil {
		return nil, err
	}
	s.creates.add(q.ip)
	return created{"username": user}, nil
}

func (s *server) createAccount(ctx context.Context, user, password string) error {
	if err := s.bouncer.register(ctx, user, password); err != nil {
		if _, ok := err.(*apiError); ok {
			return err
		}
		log.Printf("register %s: %v", user, err)
		return fail(500, "Couldn't create the account right now. Please try again later.")
	}
	// Index it for "find people" right away (soju's listing is capped).
	s.db.Exec(ctx, `INSERT INTO accounts (uname, first_seen) VALUES ($1, $2) ON CONFLICT DO NOTHING`, user, now())
	log.Printf("created %s", user)
	return nil
}

// ---- forgot password ----

func randomCode() string {
	n, _ := rand.Int(rand.Reader, big.NewInt(1_000_000))
	return fmt.Sprintf("%06d", n.Int64())
}

func (s *server) resetRequest(q *req) (any, error) {
	ctx := q.r.Context()
	user := q.lower("username")
	if !validID(user) {
		return nil, fail(400, "Please enter your a09f ID.")
	}
	if !s.bouncer.userExists(ctx, user) {
		return nil, fail(404, "There's no a09f account with that ID.")
	}
	email := s.getEmail(ctx, user)
	if email == "" {
		return nil, fail(409, "This account has no recovery email, so its password can't be reset here. Please contact the a09f admin.")
	}
	t := now()
	var sent int64
	if err := s.db.QueryRow(ctx, `SELECT sent FROM resets WHERE uname = $1`, user).Scan(&sent); err == nil && t-sent < resetCooldown {
		return nil, fail(429, "We just sent you a code. Please check your email, or wait a minute to get a new one.")
	}
	code := randomCode()
	if _, err := s.db.Exec(ctx, `INSERT INTO resets (uname, code_hash, expires, tries, sent) VALUES ($1, $2, $3, 0, $4)
		ON CONFLICT (uname) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires, tries = 0, sent = excluded.sent`,
		user, codeHash(user, code), t+resetCodeTTL, t); err != nil {
		return nil, err
	}
	body := fmt.Sprintf("Hi %s,\n\nYour a09f password reset code is: %s\n\n"+
		"Enter it in the a09f app within %d minutes to choose a new password.\n"+
		"If you didn't ask for this, you can ignore this email: your password stays the same.\n", user, code, resetCodeTTL/60)
	if err := s.sendMail(email, "Your a09f password reset code", body); err != nil {
		log.Printf("reset mail for %s failed: %v", user, err)
		s.db.Exec(ctx, `DELETE FROM resets WHERE uname = $1`, user)
		return nil, fail(503, "Couldn't send the email right now. Please try again later.")
	}
	log.Printf("reset code sent for %s", user)
	return obj{"email": maskEmail(email)}, nil
}

func (s *server) resetConfirm(q *req) (any, error) {
	ctx := q.r.Context()
	bad := fail(400, "That code isn't right, or it has expired. Please check it or ask for a new one.")
	user := q.lower("username")
	if !validID(user) {
		return nil, bad
	}
	code := q.str("code")
	password := q.raw("password")
	if err := validatePassword(password); err != nil {
		return nil, err
	}
	var hash string
	var expires, tries int64
	err := s.db.QueryRow(ctx, `SELECT code_hash, expires, tries FROM resets WHERE uname = $1`, user).Scan(&hash, &expires, &tries)
	if err != nil || expires < now() || tries >= resetMaxTries {
		return nil, bad
	}
	if subtle.ConstantTimeCompare([]byte(hash), []byte(codeHash(user, code))) != 1 {
		s.db.Exec(ctx, `UPDATE resets SET tries = tries + 1 WHERE uname = $1`, user)
		return nil, bad
	}
	s.db.Exec(ctx, `DELETE FROM resets WHERE uname = $1`, user)
	if err := s.bouncer.setPassword(ctx, user, password); err != nil {
		log.Printf("password reset %s: %v", user, err)
		return nil, fail(500, "Couldn't change your password right now. Please try again later.")
	}
	log.Printf("password reset for %s", user)
	s.sess.endUser(ctx, user, "")
	s.hub.push(user, "signed-out", obj{"except": "", "reason": "password"})
	return obj{"username": user}, nil
}

// ---- POST /email {"username","password"[,"email"]}: read or set ----

func (s *server) email(q *req) (any, error) {
	ctx := q.r.Context()
	user := q.lower("username")
	if err := s.passwordOK(q, user, q.raw("password")); err != nil {
		return nil, err
	}
	if q.has("email") {
		e, err := validateEmail(q.str("email"))
		if err != nil {
			return nil, err
		}
		if err := s.setEmail(ctx, user, e); err != nil {
			return nil, err
		}
	}
	return obj{"email": s.getEmail(ctx, user)}, nil
}

// ---- sessions ----

func (s *server) newSession(q *req) (any, error) {
	user := q.lower("username")
	if err := s.passwordOK(q, user, q.raw("password")); err != nil {
		return nil, err
	}
	token, err := s.sess.create(q.r.Context(), user, q.raw("device"))
	if err != nil {
		return nil, err
	}
	return obj{"token": token, "sid": sidOf(token), "admin": s.cfg.admins[user]}, nil
}

func (s *server) endSession(q *req) (any, error) {
	s.sess.end(q.r.Context(), q.token)
	return obj{}, nil
}

func (s *server) getSessions(q *req) (any, error) {
	list, err := s.sess.list(q.r.Context(), q.me, q.token)
	if err != nil {
		return nil, err
	}
	return obj{"sessions": list}, nil
}

func (s *server) revokeSession(q *req) (any, error) {
	sid := q.str("sid")
	ok := s.sess.revoke(q.r.Context(), q.me, sid)
	if ok {
		s.hub.push(q.me, "signed-out", obj{"only": sid, "reason": "revoked"})
	}
	return obj{"revoked": ok}, nil
}

func (s *server) revokeOthers(q *req) (any, error) {
	s.sess.endUser(q.r.Context(), q.me, q.token)
	s.hub.push(q.me, "signed-out", obj{"except": q.sid, "reason": "password"})
	return obj{}, nil
}

// seedDemo creates demo accounts that don't exist yet (used by
// scripts/seed-demo.sh; skips the per-IP limits).
func (s *server) seedDemo(ctx context.Context, users []string, password string) error {
	for _, u := range users {
		u = strings.ToLower(strings.TrimSpace(u))
		if u == "" {
			continue
		}
		if err := validateID(u); err != nil {
			return fmt.Errorf("%s: %v", u, err)
		}
		if s.bouncer.userExists(ctx, u) {
			fmt.Printf("%s: already there\n", u)
			continue
		}
		if err := s.createAccount(ctx, u, password); err != nil {
			return fmt.Errorf("%s: %v", u, err)
		}
		s.setEmail(ctx, u, u+"@demo.a09f.invalid")
		fmt.Printf("%s: created\n", u)
	}
	return nil
}
