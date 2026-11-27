#!/bin/sh
# Backup persistent docker volumes to ./backups/<timestamp>/ (gitignored).
# Safe to run while the stack is up: volumes are tarred read-only from a
# throwaway alpine container. Schedule via cron, e.g. daily:
#   17 3 * * *  /path/to/server/scripts/backup.sh >> /var/log/irc-backup.log 2>&1
set -eu

cd "$(dirname "$0")/.."

PROJECT=irc
KEEP=14   # retain the newest N backup sets

STAMP=$(date +%Y%m%d-%H%M%S)
DEST="backups/$STAMP"
mkdir -p "$DEST"

# postgres-data = soju DB (users, networks, message history)
# atheme-data   = services.db (NickServ/ChanServ accounts & channels)
# solanum-state = bandb ban.db
# soju-db       = soju admin socket + legacy sqlite remnants
# soju-uploads  = soju file uploads
# register-data = snailog account service data
for vol in postgres-data atheme-data solanum-state soju-db soju-uploads register-data; do
    if docker volume inspect "${PROJECT}_${vol}" >/dev/null 2>&1; then
        echo "backing up $vol ..."
        docker run --rm \
            -v "${PROJECT}_${vol}:/data:ro" \
            -v "$PWD/$DEST:/backup" \
            alpine:3.20 \
            tar czf "/backup/$vol.tgz" -C /data .
    else
        echo "skip $vol (volume not found)"
    fi
done

# prune old backup sets
ls -1dt backups/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    echo "pruning $old"
    rm -rf "$old"
done

echo "backup complete: $DEST"
