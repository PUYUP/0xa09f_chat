package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "modernc.org/sqlite"
)

// One-time import of the Python service's SQLite database (register.db).
//
// Runs at start-up when the file exists and hasn't been imported yet (marked
// in table migrations). The SQLite file is only read, never changed, so
// going back to the Python service still works. Sessions were in memory in
// the Python service: everyone just signs in to the service again.

// legacyTable maps one SQLite table to its Postgres table. cols are
// "sqlite_column:postgres_column[:kind]" (kind bool = 0/1 → boolean,
// json = text → jsonb).
type legacyTable struct {
	from, to string
	cols     []string
	serial   bool // has an id column with a sequence to move past the imported ids
}

var legacyTables = []legacyTable{
	{from: "emails", to: "emails", cols: []string{"username:uname", "email:email", "updated:updated"}},
	{from: "resets", to: "resets", cols: []string{"username:uname", "code_hash:code_hash", "expires:expires", "tries:tries", "sent:sent"}},
	{from: "friends", to: "friends", cols: []string{"owner:owner", "friend:friend", "grp:grp", "added:added"}},
	{from: "friend_requests", to: "friend_requests", cols: []string{"from_user:from_user", "to_user:to_user", "grp:grp", "msg:msg", "created:created"}},
	{from: "prefs", to: "prefs", cols: []string{"owner:owner", "data:data:json"}},
	{from: "notes", to: "notes", cols: []string{"owner:owner", "about:about", "text:text"}},
	{from: "redactions", to: "redactions", cols: []string{"sender:sender", "target:target", "time:msg_time", "hash:hash", "created:created"}},
	{from: "reactions", to: "reactions", cols: []string{"sender:sender", "target:target", "time:msg_time", "hash:hash", "user:uname", "emoji:emoji", "created:created"}},
	{from: "edits", to: "edits", cols: []string{"sender:sender", "target:target", "time:msg_time", "hash:hash", "text:text", "edited:edited"}},
	{from: "pins", to: "pins", cols: []string{"room:room", "sender:sender", "time:msg_time", "hash:hash", "text:text", "pinned_by:pinned_by", "created:created"}},
	{from: "expiring", to: "expiring", cols: []string{"sender:sender", "target:target", "time:msg_time", "hash:hash", "due:due"}},
	{from: "saved", to: "saved", cols: []string{"user:uname", "sender:sender", "target:target", "time:msg_time", "hash:hash", "conv:conv", "text:text", "created:created"}},
	{from: "polls", to: "polls", serial: true, cols: []string{"id:id", "room:room", "author:author", "question:question", "options:options:json", "created:created"}},
	{from: "poll_votes", to: "poll_votes", cols: []string{"poll:poll", "user:uname", "option:opt"}},
	{from: "scheduled", to: "scheduled", serial: true, cols: []string{"id:id", "user:uname", "target:target", "text:text", "due:due", "sent:sent:bool"}},
	{from: "reminders", to: "reminders", serial: true, cols: []string{"id:id", "user:uname", "text:text", "due:due", "delivered:delivered:bool"}},
	{from: "announcements", to: "announcements", serial: true, cols: []string{"id:id", "author:author", "text:text", "created:created"}},
	{from: "last_seen", to: "last_seen", cols: []string{"user:uname", "time:seen"}},
	{from: "name_colors", to: "name_colors", cols: []string{"user:uname", "color:color"}},
	{from: "imv", to: "imv", cols: []string{"pair:pair", "theme:theme", "by_user:by_user"}},
	{from: "user_tz", to: "user_tz", cols: []string{"user:uname", "tz:tz", "offset:utc_offset", "updated:updated"}},
	{from: "user_active", to: "user_active", cols: []string{"user:uname", "start:start_min", "end:end_min"}},
	{from: "room_activity", to: "room_activity", cols: []string{"room:room", "day:day", "msgs:msgs"}},
	{from: "room_tz", to: "room_tz", cols: []string{"room:room", "day:day", "offset:utc_offset", "msgs:msgs"}},
	{from: "user_rooms", to: "user_rooms", cols: []string{"user:uname", "room:room", "day:day", "msgs:msgs"}},
	{from: "room_info", to: "room_info", cols: []string{"room:room", "category:category", "lang:lang", "set_by:set_by"}},
	{from: "room_reads", to: "room_reads", cols: []string{"room:room", "user:uname", "time:msg_time"}},
	{from: "events", to: "events", serial: true, cols: []string{"id:id", "room:room", "creator:creator", "title:title", "start:start", "created:created", "notified:notified:bool"}},
	{from: "rsvps", to: "rsvps", cols: []string{"event:event", "user:uname", "status:status"}},
}

func importLegacy(ctx context.Context, db *pgxpool.Pool, path string) error {
	if path == "" {
		return nil
	}
	if _, err := os.Stat(path); err != nil {
		return nil // nothing to import
	}
	if _, err := db.Exec(ctx, `CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, done BIGINT NOT NULL)`); err != nil {
		return err
	}
	var one int
	if db.QueryRow(ctx, `SELECT 1 FROM migrations WHERE name = 'sqlite-import'`).Scan(&one) == nil {
		return nil // already done
	}
	src, err := sql.Open("sqlite", "file:"+path+"?mode=ro&immutable=1")
	if err != nil {
		return err
	}
	defer src.Close()
	have := map[string]bool{}
	rows, err := src.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table'`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var n string
		rows.Scan(&n)
		have[n] = true
	}
	rows.Close()

	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	total := 0
	for _, t := range legacyTables {
		if !have[t.from] {
			continue
		}
		n, err := importTable(ctx, src, tx, t)
		if err != nil {
			return fmt.Errorf("%s: %w", t.from, err)
		}
		total += n
		if t.serial {
			if _, err := tx.Exec(ctx, fmt.Sprintf(`SELECT setval(pg_get_serial_sequence('%s', 'id'),
				GREATEST((SELECT COALESCE(MAX(id), 0) FROM %s), 1))`, t.to, t.to)); err != nil {
				return fmt.Errorf("%s sequence: %w", t.to, err)
			}
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO migrations (name, done) VALUES ('sqlite-import', $1)`, now()); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	log.Printf("imported %d rows from %s (the file itself is unchanged)", total, path)
	return nil
}

func importTable(ctx context.Context, src *sql.DB, tx pgx.Tx, t legacyTable) (int, error) {
	var srcCols, dstCols, kinds []string
	for _, c := range t.cols {
		p := strings.Split(c, ":")
		kind := ""
		if len(p) > 2 {
			kind = p[2]
		}
		srcCols = append(srcCols, `"`+p[0]+`"`)
		dstCols = append(dstCols, p[1])
		kinds = append(kinds, kind)
	}
	rows, err := src.QueryContext(ctx, fmt.Sprintf(`SELECT %s FROM "%s"`, strings.Join(srcCols, ", "), t.from))
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	ph := make([]string, len(dstCols))
	for i, k := range kinds {
		ph[i] = fmt.Sprintf("$%d", i+1)
		if k == "json" {
			ph[i] += "::jsonb"
		}
	}
	insert := fmt.Sprintf(`INSERT INTO %s (%s) VALUES (%s) ON CONFLICT DO NOTHING`, t.to, strings.Join(dstCols, ", "), strings.Join(ph, ", "))
	n := 0
	for rows.Next() {
		vals := make([]any, len(srcCols))
		ptrs := make([]any, len(srcCols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return n, err
		}
		for i, k := range kinds {
			switch v := vals[i].(type) {
			case []byte:
				vals[i] = string(v)
			}
			if k == "bool" {
				switch v := vals[i].(type) {
				case int64:
					vals[i] = v != 0
				case nil:
					vals[i] = false
				}
			}
		}
		if _, err := tx.Exec(ctx, insert, vals...); err != nil {
			return n, err
		}
		n++
	}
	return n, rows.Err()
}
