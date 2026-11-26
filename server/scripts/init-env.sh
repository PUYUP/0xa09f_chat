#!/bin/sh
# Create server/.env from .env.example if needed, and fill in every random
# secret that is still missing. Never prints a secret. Safe to run again.
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || { cp .env.example .env; chmod 600 .env; echo "created .env from .env.example"; }
for key in POSTGRES_PASSWORD ERGO_DB_PASSWORD A09F_DB_PASSWORD ERGO_API_TOKEN JWT_KEY; do
    if ! grep -q "^${key}=[^ #]" .env; then
        value=$(openssl rand -hex 32)
        # drop the empty "KEY=" line before appending
        grep -v "^${key}=" .env > .env.tmp || true
        mv .env.tmp .env
        printf '%s=%s\n' "$key" "$value" >> .env
        echo "generated $key"
    fi
done
chmod 600 .env
