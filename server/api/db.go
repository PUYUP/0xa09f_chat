package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Messages are identified by sender, target (room, or for a private chat
// the person it was sent to, seen from the sender), server time in ms
// (msg_time) and a hash of the text — see server/docs/api.md.
const schema = `
CREATE TABLE IF NOT EXISTS emails (uname TEXT PRIMARY KEY, email TEXT NOT NULL, updated BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS resets (uname TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires BIGINT NOT NULL,
  tries INT NOT NULL DEFAULT 0, sent BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, uname TEXT NOT NULL, device TEXT NOT NULL,
  created BIGINT NOT NULL, last BIGINT NOT NULL, expires BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_uname ON sessions (uname);
CREATE TABLE IF NOT EXISTS profiles (uname TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
  about TEXT NOT NULL DEFAULT '', updated BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS friends (owner TEXT NOT NULL, friend TEXT NOT NULL, grp TEXT NOT NULL, added BIGINT NOT NULL,
  PRIMARY KEY (owner, friend));
CREATE INDEX IF NOT EXISTS friends_friend ON friends (friend);
CREATE TABLE IF NOT EXISTS friend_requests (from_user TEXT NOT NULL, to_user TEXT NOT NULL, grp TEXT NOT NULL,
  msg TEXT NOT NULL, created BIGINT NOT NULL, PRIMARY KEY (from_user, to_user));
CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests (to_user);
CREATE TABLE IF NOT EXISTS prefs (owner TEXT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS notes (owner TEXT NOT NULL, about TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (owner, about));

CREATE TABLE IF NOT EXISTS redactions (sender TEXT NOT NULL, target TEXT NOT NULL, msg_time BIGINT NOT NULL, hash TEXT NOT NULL,
  created BIGINT NOT NULL, PRIMARY KEY (sender, target, msg_time, hash));
CREATE INDEX IF NOT EXISTS redactions_created ON redactions (created);
CREATE TABLE IF NOT EXISTS reactions (sender TEXT NOT NULL, target TEXT NOT NULL, msg_time BIGINT NOT NULL, hash TEXT NOT NULL,
  uname TEXT NOT NULL, emoji TEXT NOT NULL, created BIGINT NOT NULL, PRIMARY KEY (sender, target, msg_time, hash, uname, emoji));
CREATE INDEX IF NOT EXISTS reactions_conv ON reactions (target, msg_time);
CREATE TABLE IF NOT EXISTS edits (sender TEXT NOT NULL, target TEXT NOT NULL, msg_time BIGINT NOT NULL, hash TEXT NOT NULL,
  text TEXT NOT NULL, edited BIGINT NOT NULL, PRIMARY KEY (sender, target, msg_time, hash));
CREATE INDEX IF NOT EXISTS edits_conv ON edits (target, msg_time);
CREATE TABLE IF NOT EXISTS pins (room TEXT NOT NULL, sender TEXT NOT NULL, msg_time BIGINT NOT NULL, hash TEXT NOT NULL,
  text TEXT NOT NULL, pinned_by TEXT NOT NULL, created BIGINT NOT NULL, PRIMARY KEY (room, sender, msg_time, hash));
CREATE TABLE IF NOT EXISTS expiring (sender TEXT NOT NULL, target TEXT NOT NULL, msg_time BIGINT NOT NULL, hash TEXT NOT NULL,
  due BIGINT NOT NULL, PRIMARY KEY (sender, target, msg_time, hash));
CREATE INDEX IF NOT EXISTS expiring_due ON expiring (due);
CREATE INDEX IF NOT EXISTS expiring_conv ON expiring (target, msg_time);
CREATE TABLE IF NOT EXISTS saved (uname TEXT NOT NULL, sender TEXT NOT NULL, target TEXT NOT NULL, msg_time BIGINT NOT NULL,
  hash TEXT NOT NULL, conv TEXT NOT NULL, text TEXT NOT NULL, created BIGINT NOT NULL, PRIMARY KEY (uname, sender, target, msg_time, hash));
CREATE TABLE IF NOT EXISTS polls (id BIGSERIAL PRIMARY KEY, room TEXT NOT NULL, author TEXT NOT NULL, question TEXT NOT NULL,
  options JSONB NOT NULL, created BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS poll_votes (poll BIGINT NOT NULL, uname TEXT NOT NULL, opt INT NOT NULL, PRIMARY KEY (poll, uname));
CREATE TABLE IF NOT EXISTS scheduled (id BIGSERIAL PRIMARY KEY, uname TEXT NOT NULL, target TEXT NOT NULL, text TEXT NOT NULL,
  due BIGINT NOT NULL, sent BOOLEAN NOT NULL DEFAULT FALSE);
CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled (due) WHERE NOT sent;
CREATE TABLE IF NOT EXISTS reminders (id BIGSERIAL PRIMARY KEY, uname TEXT NOT NULL, text TEXT NOT NULL, due BIGINT NOT NULL,
  delivered BOOLEAN NOT NULL DEFAULT FALSE);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (due) WHERE NOT delivered;
CREATE TABLE IF NOT EXISTS announcements (id BIGSERIAL PRIMARY KEY, author TEXT NOT NULL, text TEXT NOT NULL, created BIGINT NOT NULL);

CREATE TABLE IF NOT EXISTS last_seen (uname TEXT PRIMARY KEY, seen BIGINT NOT NULL);
-- Who exists, for "find people": soju's listing is capped ("N more users
-- omitted"), so the names are indexed here and refreshed from soju (see
-- accounts.go). Rows are never deleted automatically (lookups are cheap).
CREATE TABLE IF NOT EXISTS accounts (uname TEXT PRIMARY KEY, first_seen BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS name_colors (uname TEXT PRIMARY KEY, color TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imv (pair TEXT PRIMARY KEY, theme TEXT NOT NULL, by_user TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_tz (uname TEXT PRIMARY KEY, tz TEXT NOT NULL, utc_offset INT NOT NULL, updated BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS user_active (uname TEXT PRIMARY KEY, start_min INT NOT NULL, end_min INT NOT NULL);

CREATE TABLE IF NOT EXISTS room_activity (room TEXT NOT NULL, day TEXT NOT NULL, msgs INT NOT NULL, PRIMARY KEY (room, day));
CREATE TABLE IF NOT EXISTS room_tz (room TEXT NOT NULL, day TEXT NOT NULL, utc_offset INT NOT NULL, msgs INT NOT NULL,
  PRIMARY KEY (room, day, utc_offset));
CREATE TABLE IF NOT EXISTS user_rooms (uname TEXT NOT NULL, room TEXT NOT NULL, day TEXT NOT NULL, msgs INT NOT NULL,
  PRIMARY KEY (uname, room, day));
CREATE INDEX IF NOT EXISTS user_rooms_room ON user_rooms (room, day);
CREATE TABLE IF NOT EXISTS room_info (room TEXT PRIMARY KEY, category TEXT NOT NULL, lang TEXT NOT NULL, set_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS room_welcome (room TEXT PRIMARY KEY, text TEXT NOT NULL, set_by TEXT NOT NULL, updated BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS room_reads (room TEXT NOT NULL, uname TEXT NOT NULL, msg_time BIGINT NOT NULL, PRIMARY KEY (room, uname));
CREATE TABLE IF NOT EXISTS events (id BIGSERIAL PRIMARY KEY, room TEXT NOT NULL, creator TEXT NOT NULL, title TEXT NOT NULL,
  start BIGINT NOT NULL, created BIGINT NOT NULL, notified BOOLEAN NOT NULL DEFAULT FALSE);
CREATE INDEX IF NOT EXISTS events_room ON events (room, start);
CREATE TABLE IF NOT EXISTS rsvps (event BIGINT NOT NULL, uname TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (event, uname));
`

func openDB(ctx context.Context, url, passwordFile string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	if passwordFile != "" {
		b, err := os.ReadFile(passwordFile)
		if err != nil {
			return nil, fmt.Errorf("read db password file: %w", err)
		}
		cfg.ConnConfig.Password = strings.TrimSpace(string(b))
	}
	cfg.MaxConns = 32
	var pool *pgxpool.Pool
	// Postgres may still be starting (docker): retry for a while.
	for i := 0; i < 30; i++ {
		pool, err = pgxpool.NewWithConfig(ctx, cfg)
		if err == nil {
			if err = pool.Ping(ctx); err == nil {
				return pool, nil
			}
			pool.Close()
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return nil, err
}

func migrate(ctx context.Context, db *pgxpool.Pool) error {
	for _, stmt := range strings.Split(schema, ";\n") {
		if stmt = strings.TrimSpace(stmt); stmt == "" {
			continue
		}
		if _, err := db.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("schema: %w (%.60s)", err, stmt)
		}
	}
	return nil
}

func noRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

func now() int64 { return time.Now().Unix() }

func today() string { return time.Now().UTC().Format("2006-01-02") }

func daysAgo(n int) string { return time.Now().UTC().AddDate(0, 0, -n).Format("2006-01-02") }

// collect reads every row with scan into a slice.
func collect[T any](rows pgx.Rows, scan func(pgx.Rows) (T, error)) ([]T, error) {
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

type pgxRows = pgx.Rows

func sortSlice[T any](s []T, less func(a, b T) bool) {
	sort.SliceStable(s, func(i, j int) bool { return less(s[i], s[j]) })
}
