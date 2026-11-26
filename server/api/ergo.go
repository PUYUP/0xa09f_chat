package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ergo talks to the IRC server: its HTTP API for accounts, and IRC itself
// (signed in with a short-lived token) to act for a user.
type ergo struct {
	api, token, ircAddr string
	jwtKey              []byte
	http                *http.Client

	mu       sync.Mutex
	exists   map[string]existsHit
	accounts []string
	listedAt time.Time
}

type existsHit struct {
	ok bool
	at time.Time
}

func newErgo(cfg config) *ergo {
	return &ergo{
		api: cfg.ergoAPI, token: cfg.ergoToken, ircAddr: cfg.ergoIRC, jwtKey: []byte(cfg.jwtKey),
		http:   &http.Client{Timeout: 15 * time.Second},
		exists: map[string]existsHit{},
	}
}

// call POSTs to Ergo's API. Ergo answers {"success": bool, ...}.
func (e *ergo) call(ctx context.Context, path string, body any, out any) error {
	data, _ := json.Marshal(body)
	r, err := http.NewRequestWithContext(ctx, "POST", e.api+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	r.Header.Set("Authorization", "Bearer "+e.token)
	r.Header.Set("Content-Type", "application/json")
	resp, err := e.http.Do(r)
	if err != nil {
		return fmt.Errorf("ergo %s: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("ergo %s: HTTP %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

type ergoReply struct {
	Success      bool   `json:"success"`
	Error        string `json:"error"`
	ErrorCode    string `json:"errorCode"`
	AccountName  string `json:"accountName"`
	RegisteredAt string `json:"registeredAt"`
}

// checkAuth: are these the account's credentials?
func (e *ergo) checkAuth(ctx context.Context, user, password string) (bool, error) {
	var r ergoReply
	if err := e.call(ctx, "/v1/check_auth", obj{"accountName": user, "passphrase": password}, &r); err != nil {
		return false, err
	}
	return r.Success && strings.EqualFold(r.AccountName, user), nil
}

func (e *ergo) register(ctx context.Context, user, password string) error {
	var r ergoReply
	if err := e.call(ctx, "/v1/ns/saregister", obj{"accountName": user, "passphrase": password}, &r); err != nil {
		return err
	}
	if !r.Success {
		return fmt.Errorf("saregister %s: %s %s", user, r.ErrorCode, r.Error)
	}
	e.mu.Lock()
	e.exists[user] = existsHit{true, time.Now()}
	e.listedAt = time.Time{}
	e.mu.Unlock()
	return nil
}

func (e *ergo) setPassword(ctx context.Context, user, password string) error {
	var r ergoReply
	if err := e.call(ctx, "/v1/ns/passwd", obj{"accountName": user, "passphrase": password}, &r); err != nil {
		return err
	}
	if !r.Success {
		return fmt.Errorf("passwd %s: %s %s", user, r.ErrorCode, r.Error)
	}
	return nil
}

// info returns whether the account exists and when it was registered.
func (e *ergo) info(ctx context.Context, user string) (bool, time.Time, error) {
	var r ergoReply
	if err := e.call(ctx, "/v1/ns/info", obj{"accountName": user}, &r); err != nil {
		return false, time.Time{}, err
	}
	t, _ := time.Parse(time.RFC3339Nano, r.RegisteredAt)
	return r.Success, t, nil
}

// accountExists, cached for 5 minutes.
func (e *ergo) accountExists(ctx context.Context, user string) bool {
	if !validID(user) {
		return false
	}
	e.mu.Lock()
	hit, ok := e.exists[user]
	e.mu.Unlock()
	if ok && time.Since(hit.at) < 5*time.Minute {
		return hit.ok
	}
	found, _, err := e.info(ctx, user)
	if err != nil {
		return false
	}
	e.mu.Lock()
	e.exists[user] = existsHit{found, time.Now()}
	e.mu.Unlock()
	return found
}

// allAccounts lists every account ID, cached a minute.
func (e *ergo) allAccounts(ctx context.Context) []string {
	e.mu.Lock()
	if time.Since(e.listedAt) < time.Minute {
		out := e.accounts
		e.mu.Unlock()
		return out
	}
	e.mu.Unlock()
	var r struct {
		Success  bool `json:"success"`
		Accounts []struct {
			AccountName string `json:"accountName"`
		} `json:"accounts"`
	}
	if err := e.call(ctx, "/v1/account_list", obj{}, &r); err != nil || !r.Success {
		e.mu.Lock()
		defer e.mu.Unlock()
		return e.accounts
	}
	out := make([]string, 0, len(r.Accounts))
	for _, a := range r.Accounts {
		if u := strings.ToLower(a.AccountName); validID(u) {
			out = append(out, u)
		}
	}
	e.mu.Lock()
	e.accounts, e.listedAt = out, time.Now()
	e.mu.Unlock()
	return out
}

// channels the user's (always-on) client is in, lower case.
func (e *ergo) channels(ctx context.Context, user string) (map[string]bool, error) {
	var r struct {
		Success  bool `json:"success"`
		Channels []struct {
			Name string `json:"name"`
		} `json:"channels"`
	}
	if err := e.call(ctx, "/v1/whois", obj{"nickname": user}, &r); err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, c := range r.Channels {
		out[strings.ToLower(c.Name)] = true
	}
	return out, nil
}

// ---- acting for a user over IRC ----

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// jwtFor signs a one-minute login token for an account (Ergo jwt-auth).
func (e *ergo) jwtFor(user string) string {
	head := b64url([]byte(`{"alg":"HS256","typ":"JWT"}`))
	claims, _ := json.Marshal(obj{"preferred_username": user, "exp": time.Now().Add(time.Minute).Unix()})
	body := head + "." + b64url(claims)
	mac := hmac.New(sha256.New, e.jwtKey)
	mac.Write([]byte(body))
	return body + "." + b64url(mac.Sum(nil))
}

// actAs signs in as user (one more device of their always-on client, kept
// away so friends don't see them come online), sends lines, and leaves.
// With no lines it just makes sure the account's client exists on the
// network (a new account: messages to it work right away).
func (e *ergo) actAs(ctx context.Context, user string, lines []string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", e.ircAddr)
	if err != nil {
		return err
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	w := bufio.NewWriter(conn)
	send := func(l string) {
		w.WriteString(l + "\r\n")
		w.Flush()
	}
	send("CAP LS 302")
	send("NICK " + user)
	send("USER a09f 0 * :a09f")
	rd := bufio.NewReader(conn)
	authed, registered := false, false
	for {
		raw, err := rd.ReadString('\n')
		if err != nil {
			return fmt.Errorf("act as %s: %w", user, err)
		}
		line := strings.TrimRight(raw, "\r\n")
		if strings.HasPrefix(line, "@") { // tags
			if i := strings.IndexByte(line, ' '); i > 0 {
				line = line[i+1:]
			}
		}
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		if f[0] == "PING" {
			send("PONG " + strings.Join(f[1:], " "))
			continue
		}
		if f[0] == "AUTHENTICATE" && len(f) > 1 && f[1] == "+" {
			payload := base64.StdEncoding.EncodeToString([]byte(user + "\x00jwt\x00" + e.jwtFor(user)))
			for len(payload) >= 400 {
				send("AUTHENTICATE " + payload[:400])
				payload = payload[400:]
			}
			if payload == "" {
				send("AUTHENTICATE +")
			} else {
				send("AUTHENTICATE " + payload)
			}
			continue
		}
		if len(f) < 2 {
			continue
		}
		switch f[1] {
		case "CAP":
			if len(f) > 3 && f[3] == "LS" && !strings.Contains(line, " LS * ") {
				send("CAP REQ :sasl draft/pre-away")
			} else if len(f) > 3 && f[3] == "ACK" {
				send("AUTHENTICATE IRCV3BEARER")
			} else if len(f) > 3 && f[3] == "NAK" {
				return fmt.Errorf("act as %s: caps refused", user)
			}
		case "903":
			authed = true
			send("AWAY :a09f") // draft/pre-away: this device never shows as online
			send("CAP END")
		case "902", "904", "905", "906", "907":
			return fmt.Errorf("act as %s: sign-in refused (%s)", user, f[1])
		case "376", "422": // end of MOTD: signed in
			if !authed || registered {
				continue
			}
			registered = true
			for _, l := range lines {
				send(l)
			}
			send("PING :a09f-done")
		case "PONG":
			if registered && strings.Contains(line, "a09f-done") {
				send("QUIT")
				return nil
			}
		}
		if f[0] == "ERROR" {
			return fmt.Errorf("act as %s: %s", user, line)
		}
	}
}
