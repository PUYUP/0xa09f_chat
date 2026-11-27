#!/bin/sh
# One-time setup for the Go account service (server/api), safe to run again:
#   1. adds SNAILOG_DB_PASSWORD (random) to .env if it's missing — never printed;
#   2. creates the postgres role "snailog" and database "snailog" in the running
#      postgres container (the soju database is not touched).
# Run from anywhere; needs `docker compose up -d postgres` first.
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || { echo ".env is missing: cp .env.example .env first" >&2; exit 1; }
if ! grep -q '^SNAILOG_DB_PASSWORD=[^ #]' .env; then
    grep -v '^SNAILOG_DB_PASSWORD=' .env > .env.tmp || true
    mv .env.tmp .env
    printf 'SNAILOG_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" >> .env
    chmod 600 .env
    echo "generated SNAILOG_DB_PASSWORD in .env"
fi
pw=$(grep '^SNAILOG_DB_PASSWORD=' .env | head -1 | cut -d= -f2-)
# SQL goes in on stdin, so the password never shows up in a process list.
docker exec -i postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'snailog') THEN
    CREATE ROLE snailog LOGIN PASSWORD '${pw}';
  ELSE
    ALTER ROLE snailog LOGIN PASSWORD '${pw}';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE snailog OWNER snailog'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'snailog') \gexec
SQL
echo "postgres: role + database snailog ready"
