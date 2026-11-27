#!/bin/sh
# Solanum refuses to run as root and leaves a stale pidfile behind on
# unclean shutdown; clear it so restarts don't false-positive on
# "daemon is already running".
rm -f /tmp/solanum.pid /var/local/solanum.pid

# Server links carry their passwords in the config: without them config_load()
# skips the connect block and services never link (or, before, they linked with
# an empty password). Fail instead of starting a half-configured network.
#
# Values come from docker secrets (/run/secrets/<name>, generated from .env by
# scripts/sync-secrets.sh); the matching env var is the fallback so the
# container still works when secrets are not mounted (e.g. ad-hoc runs).
for pair in link-solanum-send:LINK_SOLANUM_SEND \
            link-solanum-accept:LINK_SOLANUM_ACCEPT \
            oper-admin-password:OPER_ADMIN_PASSWORD; do
    file=${pair%%:*}; var=${pair##*:}
    if [ -s "/run/secrets/$file" ]; then
        eval "$var=\$(tr -d ' \t\r\n' < /run/secrets/$file)"
    fi
done

: "${LINK_SOLANUM_SEND:?set LINK_SOLANUM_SEND in .env (see .env.example)}"
: "${LINK_SOLANUM_ACCEPT:?set LINK_SOLANUM_ACCEPT in .env (see .env.example)}"
: "${OPER_ADMIN_PASSWORD:?set OPER_ADMIN_PASSWORD in .env (see .env.example)}"

# The oper password is hashed here so the repo never holds even the hash.
# Restrict the charset: the value is substituted into ircd.conf via sed, so
# '|' and '&' would corrupt the render.
case "$OPER_ADMIN_PASSWORD" in
*[!A-Za-z0-9._~+-]*)
    echo "sol: OPER_ADMIN_PASSWORD may only contain [A-Za-z0-9._~+-]" >&2
    exit 1
    ;;
esac
OPER_ADMIN_PASSWORD_HASH=$(openssl passwd -6 "$OPER_ADMIN_PASSWORD")

# The bouncer's own address: only it is treated as the bouncer (auth "soju" in
# ircd.conf.tmpl). It comes from a docker secret (./secrets/soju-host.ip, see
# scripts/soju-host-ip.sh) rather than env so the rule cannot silently render
# as "*" - if the file is missing, stop here.
if [ ! -s /run/secrets/soju-ip ]; then
    echo "sol: /run/secrets/soju-ip is missing or empty" >&2
    exit 1
fi
SOJU_HOST=$(tr -d ' \t\r\n' < /run/secrets/soju-ip)
case "$SOJU_HOST" in
*[!0-9.]* | "")
    echo "sol: soju-host.ip must be an IPv4 address, got '$SOJU_HOST'" >&2
    exit 1
    ;;
esac

# Render ircd.conf from the template with secrets/hostnames injected.
sed -e "s|__LINK_SOLANUM_SEND__|${LINK_SOLANUM_SEND}|g" \
    -e "s|__LINK_SOLANUM_ACCEPT__|${LINK_SOLANUM_ACCEPT}|g" \
    -e "s|__ATHEME_HOST__|${ATHEME_HOST:-atheme}|g" \
    -e "s|__SOJU_HOST__|${SOJU_HOST}|g" \
    -e "s|__OPER_ADMIN_PASSWORD__|${OPER_ADMIN_PASSWORD_HASH}|g" \
    /etc/solanum/ircd.conf.tmpl > /tmp/ircd.conf

# An unreplaced placeholder would leave an auth rule matching nothing (or the
# connect block with a literal password): refuse to start.
if grep -q '__[A-Z_]*__' /tmp/ircd.conf; then
    echo "sol: ircd.conf still has placeholders: $(grep -o '__[A-Z_]*__' /tmp/ircd.conf | sort -u | tr '\n' ' ')" >&2
    exit 1
fi

exec solanum -foreground -logfile /dev/stdout \
    -configfile /tmp/ircd.conf \
    -pidfile /tmp/solanum.pid "$@"
