package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"net"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// bouncer talks to soju: `sojuctl` over soju's admin unix socket (mounted
// from the soju-db volume) for accounts and acting for a user, and a real
// SASL login on soju's IRC port to check passwords.
//
// Accounts are looked up through the admin socket only (BOUNCER_LOOKUP=ctl):
// this service opens no IRC connection to solanum, the port every bouncer
// user's upstream comes from, so it cannot end up in a position to claim one
// of their nicks.
//
// Every a09f account is a soju user with one upstream network (NETWORK_NAME)
// to solanum, created with auto-away: soju marks it away while no device is
// connected, which the app shows as Offline.
type bouncer struct {
	sojuctl  []string
	upstream string // e.g. ircs://solanum:6697
	network  string // soju network name of every user
	ircAddr  string // soju's IRC listener inside the docker network
	db       *pgxpool.Pool // accounts index (searchAccounts/syncAccounts)

	// ctlLookup answers "does this user exist?" from BouncerServ (the admin
	// socket) instead of logging into soju. Default true: doing it over IRC
	// would need this container to reach the port soju's upstreams come from.
	ctlLookup bool

	mu       sync.Mutex // serializes account mutations
	cacheMu  sync.Mutex
	exists   map[string]existsHit
	accounts []string
	listedAt time.Time
	syncedAt time.Time // last time new users were copied into the accounts table
}

type existsHit struct {
	ok bool
	at time.Time
}

func newBouncer(cfg config, db *pgxpool.Pool) *bouncer {
	return &bouncer{
		sojuctl:   []string{"sojuctl", "-config", cfg.sojuConfig},
		upstream:  cfg.upstream, network: cfg.network, ircAddr: cfg.sojuIRC,
		exists:    map[string]existsHit{},
		ctlLookup: cfg.bouncerLookup != "irc",
		db:        db,
	}
}

// ctl runs sojuctl with argv (no shell: arguments are never interpreted).
func (b *bouncer) ctl(ctx context.Context, argv ...string) (int, string) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, b.sojuctl[0], append(b.sojuctl[1:], argv...)...)
	out, err := cmd.CombinedOutput()
	code := 0
	if err != nil {
		code = 1
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
	}
	return code, strings.TrimSpace(string(out))
}

// checkAuth: does soju accept these credentials? (SASL PLAIN on its IRC port)
func (b *bouncer) checkAuth(ctx context.Context, user, password string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", b.ircAddr)
	if err != nil {
		return false, err
	}
	defer conn.Close()
	dl, _ := ctx.Deadline()
	conn.SetDeadline(dl)
	auth := base64.StdEncoding.EncodeToString([]byte("\x00" + user + "\x00" + password))
	for _, l := range []string{"CAP REQ :sasl", "NICK a09f-check", "USER a09f-check 0 * :check", "AUTHENTICATE PLAIN"} {
		fmt.Fprintf(conn, "%s\r\n", l)
	}
	rd := bufio.NewReader(conn)
	for {
		line, err := rd.ReadString('\n')
		if err != nil {
			return false, nil // closed without an answer: not accepted
		}
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		if f[0] == "AUTHENTICATE" {
			fmt.Fprintf(conn, "AUTHENTICATE %s\r\n", auth)
			continue
		}
		if len(f) > 1 {
			switch f[1] {
			case "903":
				fmt.Fprintf(conn, "QUIT\r\n")
				return true, nil
			case "902", "904", "905", "906", "907":
				return false, nil
			}
		}
	}
}

func (b *bouncer) userExists(ctx context.Context, user string) bool {
	if !validID(user) {
		return false
	}
	if b.ctlLookup {
		return b.userInCtl(ctx, user)
	}
	code, _ := b.ctl(ctx, "user", "status", user)
	return code == 0
}

// userInCtl asks BouncerServ whether the user exists. The reply is only the
// answer to that one line, so it names the user when they do exist ("<name>:
// ...") and the admin socket prints an error (exit code 1) when they don't.
// Never match on the error text: a user could be called something like
// "no such user".
func (b *bouncer) userInCtl(ctx context.Context, user string) bool {
	code, out := b.ctl(ctx, "user", "status", user)
	if code != 0 {
		return false
	}
	for _, l := range strings.Split(out, "\n") {
		if name, _, ok := strings.Cut(l, ":"); ok && strings.EqualFold(strings.TrimSpace(name), user) {
			return true
		}
	}
	return false
}

// register creates the soju user and its upstream network (rolled back if
// the second step fails).
func (b *bouncer) register(ctx context.Context, user, password string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.userExists(ctx, user) {
		return fail(409, "That ID is already taken. Please choose another.")
	}
	if code, out := b.ctl(ctx, "user", "create", "-username", user, "-password", password,
		"-nick", user, "-realname", user); code != 0 {
		return fmt.Errorf("user create %s: %s", user, out)
	}
	if code, out := b.ctl(ctx, "user", "run", user, "network", "create", "-addr", b.upstream, "-name", b.network,
		"-nick", user, "-realname", user,
		// Away while no device is connected: how the app tells Offline from Online.
		"-auto-away", "true"); code != 0 {
		b.rollback(ctx, user)
		return fmt.Errorf("network create for %s: %s", user, out)
	}
	b.cacheMu.Lock()
	b.exists[user] = existsHit{true, time.Now()}
	b.listedAt = time.Time{}
	b.cacheMu.Unlock()
	return nil
}

var deleteTokenRe = regexp.MustCompile(`user delete \S+ ([0-9A-Za-z]+)"`)

// rollback deletes a half-created user (soju asks for a confirmation token).
func (b *bouncer) rollback(ctx context.Context, user string) {
	_, out := b.ctl(ctx, "user", "delete", user)
	if m := deleteTokenRe.FindStringSubmatch(out); m != nil {
		_, out = b.ctl(ctx, "user", "delete", user, m[1])
	}
	log.Printf("rollback %s: %s", user, out)
}

// setPassword changes the password in soju, then NickServ (through the
// user's own identified upstream) and soju's stored SASL login, if linked.
func (b *bouncer) setPassword(ctx context.Context, user, password string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if code, out := b.ctl(ctx, "user", "update", user, "-password", password); code != 0 {
		return fmt.Errorf("password update %s: %s", user, out)
	}
	code, out := b.ctl(ctx, "user", "run", user, "sasl", "status", "-network", b.network)
	if code == 0 && strings.Contains(strings.ToLower(out), fmt.Sprintf("account %q", user)) {
		b.ctl(ctx, "user", "run", user, "network", "quote", b.network, "PRIVMSG NickServ :SET PASSWORD "+password)
		time.Sleep(1500 * time.Millisecond)
		if code, out := b.ctl(ctx, "user", "run", user, "sasl", "set-plain", "-network", b.network, user, password); code != 0 {
			log.Printf("sasl update %s failed: %s", user, out)
		}
	}
	return nil
}

// accountExists, cached for 5 minutes.
func (b *bouncer) accountExists(ctx context.Context, user string) bool {
	if !validID(user) {
		return false
	}
	b.cacheMu.Lock()
	hit, ok := b.exists[user]
	b.cacheMu.Unlock()
	if ok && time.Since(hit.at) < 5*time.Minute {
		return hit.ok
	}
	found := b.userExists(ctx, user)
	b.cacheMu.Lock()
	b.exists[user] = existsHit{found, time.Now()}
	b.cacheMu.Unlock()
	return found
}

// allAccounts lists every soju user ID ("user status" prints "<name>: …"), cached a minute.
func (b *bouncer) allAccounts(ctx context.Context) []string {
	b.cacheMu.Lock()
	if time.Since(b.listedAt) < time.Minute {
		out := b.accounts
		b.cacheMu.Unlock()
		return out
	}
	b.cacheMu.Unlock()
	code, out := b.ctl(ctx, "user", "status")
	var list []string
	if code != 0 {
		list = b.accounts // keep the last good list
	} else {
		list = parseAccounts(out)
		if len(list) < 2 && len(b.accounts) >= 2 {
			list = b.accounts
		}
	}
	b.cacheMu.Lock()
	b.accounts, b.listedAt = list, time.Now()
	b.cacheMu.Unlock()
	return list
}

// parseAccounts reads BouncerServ's "user status" (one "<name>: …" per line).
// Ops prefixes a sampled list with a notice, so only lines shaped like an entry
// count. The list is capped ("(N more users omitted)"): past that, searching
// has to go through searchAccounts.
func parseAccounts(out string) []string {
	var list []string
	for _, l := range strings.Split(out, "\n") {
		name, rest, ok := strings.Cut(l, ":")
		if !ok || !strings.HasSuffix(strings.TrimSpace(rest), "networks") {
			continue
		}
		if u := strings.TrimSpace(name); validID(u) {
			list = append(list, u)
		}
	}
	return list
}

// searchAccounts returns the users whose name contains needle: "find people"
// needs a substring match. soju's own listing is capped ("N more users
// omitted"), so names are indexed in Postgres (syncAccounts keeps it fresh);
// asking soju with "user status <needle>" is no option either, it only matches
// whole names.
func (b *bouncer) searchAccounts(ctx context.Context, db *pgxpool.Pool, needle string, limit int) []string {
	pat := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(needle) + "%"
	pre := strings.TrimSuffix(pat, "%") + "%"
	rows, err := db.Query(ctx, `SELECT uname FROM accounts WHERE uname LIKE $1
		ORDER BY (uname LIKE $2) DESC, length(uname), uname LIMIT $3`, pat, pre, limit)
	if err != nil {
		return nil
	}
	out, _ := collect(rows, func(r pgx.Rows) (string, error) { var u string; return u, r.Scan(&u) })
	return out
}

// syncAccounts copies newer soju users into the accounts table. soju's listing
// is random-sampled and capped ("N more users omitted"), so one call only shows
// a slice of everyone; asking again (at most once a minute) converges over a
// few rounds. One sojuctl call per round, never one per name.
//
// Rows are not pruned: a name missing from this round's sample is not gone, and
// a stale row only costs a "no such user" when someone writes to them.
func (b *bouncer) syncAccounts(ctx context.Context, db *pgxpool.Pool) error {
	b.cacheMu.Lock()
	fresh := time.Since(b.syncedAt) < time.Minute
	b.cacheMu.Unlock()
	if fresh {
		return nil
	}
	_, out := b.ctl(ctx, "user", "status")
	list := parseAccounts(out)
	if len(list) == 0 {
		return nil // soju down or nothing listed: try again later
	}
	if _, err := db.Exec(ctx, `INSERT INTO accounts (uname, first_seen)
		SELECT u, $2 FROM unnest($1::text[]) AS u WHERE u <> '' ON CONFLICT DO NOTHING`,
		list, now()); err != nil {
		return err
	}
	b.cacheMu.Lock()
	b.syncedAt = time.Now()
	b.cacheMu.Unlock()
	return nil
}

// sendAs sends one IRC line from the user's upstream connection (soju
// "network quote"), e.g. a scheduled message.
func (b *bouncer) sendAs(ctx context.Context, user, line string) error {
	if code, out := b.ctl(ctx, "user", "run", user, "network", "quote", b.network, line); code != 0 {
		return fmt.Errorf("network quote for %s: %s", user, out)
	}
	return nil
}
