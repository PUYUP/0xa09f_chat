#!/bin/sh
# Create server/.env for production from .env.production.example, with a fresh
# random password for every __RANDOM__. Never overwrites an existing file.
#
#   ./scripts/gen-prod-env.sh            -> server/.env
#   ./scripts/gen-prod-env.sh <path>     -> another file (e.g. to compare)
#
# Passwords are hex: they are put into config files with sed ("|" delimiter)
# and into the pgpass file (":" separated), so they must not contain those.
# Nothing is printed except the placeholders you still have to fill in.
set -eu
cd "$(dirname "$0")/.."

OUT=${1:-.env}
TEMPLATE=.env.production.example

[ -f "$TEMPLATE" ] || { echo "gen-prod-env: $TEMPLATE not found" >&2; exit 1; }
if [ -e "$OUT" ]; then
    echo "gen-prod-env: $OUT already exists; not touching it." >&2
    echo "  Move it away first, or pass another path: $0 .env.new" >&2
    exit 1
fi

umask 077
tmp="$OUT.tmp.$$"
trap 'rm -f "$tmp"' EXIT
while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
        *=__RANDOM__) printf '%s=%s\n' "${line%%=*}" "$(openssl rand -hex 24)" ;;
        *) printf '%s\n' "$line" ;;
    esac
done < "$TEMPLATE" > "$tmp"
mv "$tmp" "$OUT"
trap - EXIT
chmod 600 "$OUT"

echo "gen-prod-env: wrote $OUT (mode 600) with random passwords."
todo=$(grep -n '__ISI_' "$OUT" | cut -d= -f1 || true)
if [ -n "$todo" ]; then
    echo "Still to fill in by hand:"
    echo "$todo" | sed 's/^/  line /'
fi
grep -q '^ADMIN_USERS=$' "$OUT" && echo "  ADMIN_USERS (optional: who may send announcements)"
grep -q '^SOJU_USER=$' "$OUT" && echo "  SOJU_USER (an existing ID, used by scripts/monitor.sh)"
echo "Then: ./scripts/sync-secrets.sh && docker compose up -d"
