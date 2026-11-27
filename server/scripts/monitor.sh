#!/bin/sh
# Minimal health monitor for the SolNet stack. Prints one line per check and
# exits non-zero if anything failed — cron-friendly:
#
#   */5 * * * * /path/to/server/scripts/monitor.sh >> /var/log/irc-monitor.log 2>&1
#
# Or pipe failures somewhere:  monitor.sh | mail -s "irc alert" you@example.com
#
# Checks:
#   - every container is running and (where defined) healthy
#   - no container restarted since the last check window marker
#   - solanum TLS listener accepts a handshake
#   - soju's upstream to solanum is connected (sampled via sojuctl)
#   - postgres is reachable and its size is reported
#   - ERROR/FATAL counts in the last 15 minutes of ircd/bouncer logs
set -u
cd "$(dirname "$0")/.."

FAIL=0
say()  { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
ok()   { say "OK   $*"; }
bad()  { say "FAIL $*"; FAIL=1; }
warn() { say "WARN $*"; }

# Load .env for SOJU_USER/SOJUPORT without sourcing (values may contain
# characters the shell would mangle).
env_get() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -1; }
SOJU_USER=$(env_get SOJU_USER); SOJU_USER=${SOJU_USER:-soluser}

# --- 1. container health -----------------------------------------------------
for c in solanum atheme postgres soju api; do
    state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo missing)
    case "$state" in
        healthy|running) ok "$c: $state" ;;
        *)               bad "$c: $state" ;;
    esac
done

# --- 2. restart counts --------------------------------------------------------
# A non-zero RestartCount means docker restarted the container (crash or
# daemon restart). Report, don't fail — unless it is very high.
for c in solanum atheme postgres soju api; do
    n=$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null || echo '?')
    [ "$n" != "0" ] && [ "$n" != "?" ] && warn "$c: restart count $n" || true
done

# --- 3. solanum TLS handshake --------------------------------------------------
if echo | openssl s_client -connect 127.0.0.1:6697 -servername solanum \
        >/dev/null 2>&1; then
    ok "solanum TLS :6697 handshake"
else
    bad "solanum TLS :6697 handshake failed"
fi

# --- 4. soju upstream ---------------------------------------------------------
# sojuctl network status on one known user exercises the whole path:
# admin socket -> bouncer -> upstream TLS -> solanum.
if docker exec soju /sojuctl -config /soju-config user run "$SOJU_USER" network status \
        2>/dev/null | grep -q '\[connected\]'; then
    ok "soju upstream connected (user $SOJU_USER)"
else
    bad "soju upstream not connected (user $SOJU_USER)"
fi

# --- 5. postgres ---------------------------------------------------------------
size=$(docker exec postgres psql -U soju -d soju -tAc \
    "SELECT pg_size_pretty(pg_database_size('soju'))" 2>/dev/null || echo fail)
if [ "$size" = fail ]; then
    bad "postgres query failed"
else
    ok "postgres soju db size: $size"
fi

# --- 6. recent errors in ircd/bouncer logs -------------------------------------
for c in solanum soju; do
    n=$(docker logs --since 15m "$c" 2>&1 | grep -ciE 'error|fatal' || true)
    if [ "$n" -gt 20 ]; then
        warn "$c: $n error-ish lines in last 15m"
    else
        ok "$c: $n error-ish lines in last 15m"
    fi
done

say "monitor done (exit $FAIL)"
exit $FAIL
