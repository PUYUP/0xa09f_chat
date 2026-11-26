// Command a09f-api is the a09f account service.
//
// It complements the IRC stack (solanum + Atheme + soju) with what IRC can't
// (or shouldn't) carry: creating accounts and resetting passwords, friends
// kept on the server, live events over Server-Sent Events, and data attached
// to messages (reactions, edits, pins, polls, ...). See server/docs/api.md.
//
// Data lives in PostgreSQL (DATABASE_URL). soju is driven with sojuctl over
// its admin socket and asked to check passwords with a real SASL login.
// Data of the earlier Python service (SQLite, LEGACY_SQLITE) is imported
// once on first start.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

type config struct {
	listen       string
	databaseURL  string
	legacySQLite string
	sojuConfig   string
	sojuIRC      string
	upstream     string
	network      string
	admins       map[string]bool
	smtpHost     string
	smtpPort     string
	smtpSecurity string
	smtpUser     string
	smtpPassword string
	mailFrom     string
	maxAttempts  int
	maxCreates   int
	maxLoginFail int
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	var n int
	if _, err := fmt.Sscanf(os.Getenv(key), "%d", &n); err == nil {
		return n
	}
	return def
}

func loadConfig() config {
	admins := map[string]bool{}
	for _, u := range strings.Split(os.Getenv("ADMIN_USERS"), ",") {
		if u = strings.ToLower(strings.TrimSpace(u)); u != "" {
			admins[u] = true
		}
	}
	return config{
		listen:       env("LISTEN", ":8080"),
		databaseURL:  env("DATABASE_URL", "postgres://a09f@localhost/a09f?sslmode=disable"),
		legacySQLite: env("LEGACY_SQLITE", "/data/register.db"),
		sojuConfig:   env("SOJU_CONFIG", "/soju-config"),
		sojuIRC:      env("SOJU_IRC", "soju:6667"),
		upstream:     env("UPSTREAM_ADDR", "irc+insecure://solanum:6667"),
		network:      env("NETWORK_NAME", "solanum"),
		admins:       admins,
		smtpHost:     os.Getenv("SMTP_HOST"),
		smtpPort:     env("SMTP_PORT", "587"),
		smtpSecurity: strings.ToLower(env("SMTP_SECURITY", "starttls")),
		smtpUser:     os.Getenv("SMTP_USER"),
		smtpPassword: os.Getenv("SMTP_PASSWORD"),
		mailFrom:     env("MAIL_FROM", "a09f <no-reply@a09f.invalid>"),
		maxAttempts:  envInt("MAX_ATTEMPTS_PER_HOUR", 30),
		maxCreates:   envInt("MAX_CREATES_PER_HOUR", 5),
		maxLoginFail: envInt("MAX_LOGIN_FAILS_PER_HOUR", 10),
	}
}

func main() {
	health := flag.Bool("health", false, "check that the service on LISTEN answers, then exit (docker healthcheck)")
	seed := flag.String("seed-demo", "", "create demo accounts: comma-separated IDs (password from A09F_DEMO_PASSWORD), then exit")
	flag.Parse()
	cfg := loadConfig()
	log.SetFlags(0)
	log.SetPrefix("[api] ")

	if *health {
		port := cfg.listen
		if strings.HasPrefix(port, ":") {
			port = "127.0.0.1" + port
		}
		c := http.Client{Timeout: 3 * time.Second}
		r, err := c.Get("http://" + port + "/health")
		if err != nil || r.StatusCode != 200 {
			os.Exit(1)
		}
		os.Exit(0)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	s, err := newServer(ctx, cfg)
	if err != nil {
		log.Fatalf("start: %v", err)
	}
	if *seed != "" {
		if err := s.seedDemo(ctx, strings.Split(*seed, ","), env("A09F_DEMO_PASSWORD", "demo-1234")); err != nil {
			log.Fatalf("seed: %v", err)
		}
		return
	}

	go s.backgroundLoop(ctx)
	srv := &http.Server{
		Addr:              cfg.listen,
		Handler:           s.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: /events streams for as long as the app is open.
	}
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s.hub.closeAll()
		srv.Shutdown(shut)
	}()
	smtp := cfg.smtpHost
	if smtp == "" {
		smtp = "NOT CONFIGURED"
	}
	log.Printf("listening on %s, network %s -> %s, smtp %s:%s", cfg.listen, cfg.network, cfg.upstream, smtp, cfg.smtpPort)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
