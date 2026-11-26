#!/bin/sh
# Write secrets/soju-host.ip: the bouncer's address in the docker network.
#
# solanum only lets this address claim users' nicks, so the file is what keeps
# the bouncer's "forwarded client" privileges from being reachable by anything
# else. Read from the compose network definition, so docker-compose.yml's
# static IP for soju and this rule can never drift apart.
#
# Usage: ./scripts/soju-host-ip.sh   (run after changing the soju IP/subnet)
set -eu
cd "$(dirname "$0")/.."

. ./.env 2>/dev/null || true          # optional overrides: IRC_SUBNET
SUBNET=${IRC_SUBNET:-172.30.99.0/24}

ip=$(awk '
	/^[[:space:]]*soju:[[:space:]]*$/ { in_soju = 1; next }
	in_soju && /^[^[:space:]]/ { in_soju = 0 }
	in_soju && /ipv4_address:/ { sub(/.*ipv4_address:[[:space:]]*/, ""); print; exit }
' docker-compose.yml)

case "$ip" in
[0-9]*.[0-9]*.[0-9]*.[0-9]*) ;;
*) echo "could not read soju's ipv4_address from docker-compose.yml" >&2; exit 1 ;;
esac

mkdir -p secrets
printf '%s\n' "$ip" > secrets/soju-host.ip
chmod 644 secrets/soju-host.ip
echo "secrets/soju-host.ip = $ip (subnet $SUBNET)"