#!/bin/sh
# Generate docker secret files in server/secrets/ from server/.env.
#
# .env stays the single source of truth (it is gitignored and also read by
# the test scripts). This script copies the *secret* values into individual
# files so docker compose can mount them as secrets — they then show up in
# containers as /run/secrets/<name> instead of plaintext environment
# variables visible via `docker inspect`.
#
# Run after changing any secret in .env, then `docker compose up -d`.
#
# Permissions: the directory is 700 (nobody else on the host can open it),
# the files are 644. Docker bind-mounts them with their host owner and mode,
# and the containers read them as other users (solanum uid 1001, atheme uid
# 1000, soju/api as root with cap_drop ALL, i.e. without the right to bypass
# file modes). A 600 file owned by the deploy user is unreadable to them on
# Linux; Docker Desktop on macOS hides this. soju's lib/pq (v1.12) accepts a
# pgpass file that is not 600.
set -eu
cd "$(dirname "$0")/.."

ENV_FILE=.env
SECRETS_DIR=secrets

[ -f "$ENV_FILE" ] || { echo "sync-secrets: $ENV_FILE not found" >&2; exit 1; }

get() { # get <KEY> — value from .env, empty if unset
    sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

write_secret() { # write_secret <name> <value> [required]
    name=$1; value=$2; required=${3:-}
    if [ -z "$value" ] && [ "$required" = required ]; then
        echo "sync-secrets: $name is empty in .env" >&2
        exit 1
    fi
    # The file must exist even when empty: compose fails on a missing secret
    # file, and consumers treat an empty file the same as "not set".
    printf '%s' "$value" > "$SECRETS_DIR/$name"
    chmod 644 "$SECRETS_DIR/$name"
    if [ -z "$value" ]; then
        echo "  = $name (empty in .env)"
    else
        echo "  + $name"
    fi
}

echo "sync-secrets: writing $SECRETS_DIR/ from $ENV_FILE"

write_secret link-solanum-send    "$(get LINK_SOLANUM_SEND)"    required
write_secret link-solanum-accept  "$(get LINK_SOLANUM_ACCEPT)"  required
write_secret oper-admin-password  "$(get OPER_ADMIN_PASSWORD)"  required
write_secret postgres-password    "$(get POSTGRES_PASSWORD)"    required
write_secret snailog-db-password     "$(get SNAILOG_DB_PASSWORD)"
write_secret smtp-password        "$(get SMTP_PASSWORD)"

# lib/pq reads PGPASSFILE for soju's postgres:// connection: pgpass format is
# host:port:database:user:password. Host is the docker DNS name "postgres".
PGPASS="$SECRETS_DIR/pgpass"
PGPASS_VALUE="$(get POSTGRES_PASSWORD)"
if [ -n "$PGPASS_VALUE" ]; then
    printf 'postgres:5432:%s:%s:%s\n' "$(get POSTGRES_DB)" "$(get POSTGRES_USER)" "$PGPASS_VALUE" > "$PGPASS"
    chmod 644 "$PGPASS"
    echo "  + pgpass"
else
    rm -f "$PGPASS"
fi

echo "sync-secrets: done — run 'docker compose up -d' to apply"
