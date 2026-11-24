#!/bin/sh
# Solanum refuses to run as root and leaves a stale pidfile behind on
# unclean shutdown; clear it so restarts don't false-positive on
# "daemon is already running".
rm -f /tmp/solanum.pid /var/local/solanum.pid

# Render ircd.conf from the template with secrets/hostnames injected via env.
sed -e "s|__LINK_SOLANUM_SEND__|${LINK_SOLANUM_SEND:-}|g" \
    -e "s|__LINK_SOLANUM_ACCEPT__|${LINK_SOLANUM_ACCEPT:-}|g" \
    -e "s|__ATHEME_HOST__|${ATHEME_HOST:-atheme}|g" \
    /etc/solanum/ircd.conf.tmpl > /tmp/ircd.conf

exec solanum -foreground -logfile /dev/stdout \
    -configfile /tmp/ircd.conf \
    -pidfile /tmp/solanum.pid "$@"
