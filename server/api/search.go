package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Message search over Ergo's history database (read only).
//
// Ergo stores each message once as JSON (table history), indexed by room
// (sequence: target = casefolded room) and, for private messages, by account
// (conversations: target = account, correspondent = the other person). A
// person can search the rooms they are in and their own private chats.

type historyItem struct {
	Type        int    `json:"Type"` // 1 = PRIVMSG, 2 = NOTICE
	Nick        string `json:"Nick"` // nick!user@host of the sender
	AccountName string `json:"AccountName"`
	Message     struct {
		Message string    `json:"Message"`
		Msgid   string    `json:"Msgid"`
		Time    time.Time `json:"Time"`
	} `json:"Message"`
	Params [1]string `json:"Params"`
}

func likePattern(q string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(q) + "%"
}

// asLine turns a stored message back into an IRC line, as CHATHISTORY would send it.
func (it historyItem) asLine() string {
	cmd := "PRIVMSG"
	if it.Type == 2 {
		cmd = "NOTICE"
	}
	text := strings.NewReplacer("\r", " ", "\n", " ").Replace(it.Message.Message)
	return fmt.Sprintf("@time=%s;msgid=%s :%s %s %s :%s", it.Message.Time.UTC().Format("2006-01-02T15:04:05.000Z"),
		it.Message.Msgid, it.Nick, cmd, it.Params[0], text)
}

const searchLimit = 100

// GET /search?q=&in=  ("in" = a room or an ID; empty = everywhere I can see)
func (s *server) searchMessages(q *req) (any, error) {
	if s.history == nil {
		return nil, fail(503, "Message search isn't available on this server.")
	}
	ctx, cancel := context.WithTimeout(q.r.Context(), 10*time.Second)
	defer cancel()
	needle := strings.TrimSpace(q.query("q"))
	if len([]rune(needle)) < 2 {
		return nil, fail(400, "Type at least 2 letters.")
	}
	if len(needle) > 200 {
		needle = cut(needle, 200)
	}
	in := strings.ToLower(strings.TrimSpace(q.query("in")))
	pattern := likePattern(needle)

	var roomsToSearch []string
	var peer string // "" = all my private chats, "-" = none
	switch {
	case in == "":
		mine, err := s.ergo.channels(ctx, q.me)
		if err != nil {
			return nil, err
		}
		for r := range mine {
			if r != "#a09f-presence" {
				roomsToSearch = append(roomsToSearch, r)
			}
		}
	case isRoom(in):
		mine, err := s.ergo.channels(ctx, q.me)
		if err != nil {
			return nil, err
		}
		if !mine[in] {
			return nil, fail(403, "You can only search rooms you're in.")
		}
		roomsToSearch, peer = []string{in}, "-"
	case validID(in):
		peer = in
	default:
		return nil, errBad
	}

	var blobs [][]byte
	scan := func(rows pgx.Rows, err error) error {
		if err != nil {
			return err
		}
		got, err := collect(rows, func(r pgx.Rows) ([]byte, error) { var b []byte; return b, r.Scan(&b) })
		blobs = append(blobs, got...)
		return err
	}
	const text = `(convert_from(h.data, 'UTF8')::jsonb -> 'Message' ->> 'Message') ILIKE $2`
	if len(roomsToSearch) > 0 {
		if err := scan(s.history.Query(ctx, `SELECT h.data FROM sequence s JOIN history h ON h.id = s.history_id
			WHERE s.target = ANY($1::bytea[]) AND `+text+` ORDER BY s.nanotime DESC LIMIT $3`,
			byteSlices(roomsToSearch), pattern, searchLimit)); err != nil {
			return nil, err
		}
	}
	if peer != "-" {
		args := []any{[]byte(q.me), pattern, searchLimit}
		where := ""
		if peer != "" {
			where = " AND c.correspondent = $4"
			args = append(args, []byte(peer))
		}
		if err := scan(s.history.Query(ctx, `SELECT h.data FROM conversations c JOIN history h ON h.id = c.history_id
			WHERE c.target = $1 AND `+text+where+` ORDER BY c.nanotime DESC LIMIT $3`, args...)); err != nil {
			return nil, err
		}
	}
	items := make([]historyItem, 0, len(blobs))
	for _, b := range blobs {
		var it historyItem
		if json.Unmarshal(b, &it) == nil && (it.Type == 1 || it.Type == 2) {
			items = append(items, it)
		}
	}
	sortSlice(items, func(a, b historyItem) bool { return a.Message.Time.After(b.Message.Time) })
	if len(items) > searchLimit {
		items = items[:searchLimit]
	}
	lines := make([]string, len(items))
	for i, it := range items {
		lines[i] = it.asLine()
	}
	return obj{"lines": lines}, nil
}

func byteSlices(ss []string) [][]byte {
	out := make([][]byte, len(ss))
	for i, s := range ss {
		out[i] = []byte(s)
	}
	return out
}
