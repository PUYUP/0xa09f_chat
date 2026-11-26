#!/bin/sh
# Create the built-in rooms and the demo accounts (password demo-1234, or
# A09F_DEMO_PASSWORD). Safe to run again: existing accounts are skipped.
set -eu
cd "$(dirname "$0")/.."
USERS="alice,bob,charlie,diana,evan,frank,grace,henry,irene,jack,kate,leo,mia,nina,oscar,control"
docker compose exec -T api /a09f-api -setup-rooms
docker compose exec -T -e A09F_DEMO_PASSWORD="${A09F_DEMO_PASSWORD:-demo-1234}" api /a09f-api -seed-demo "${1:-$USERS}"
