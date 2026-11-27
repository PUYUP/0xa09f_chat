#!/bin/sh
# Render atheme.conf + ~/.msmtprc from the templates/env, then delegate to
# the image's own entrypoint which performs writability checks and starts
# atheme-services.
set -e

sed -e "s|__LINK_SOLANUM_SEND__|${LINK_SOLANUM_SEND:-}|g" \
    -e "s|__LINK_SOLANUM_ACCEPT__|${LINK_SOLANUM_ACCEPT:-}|g" \
    /atheme/etc/atheme.conf.tmpl > /atheme/etc/atheme.conf

# msmtp is the sendmail-compatible MTA atheme calls (mta = "/usr/bin/msmtp").
# It runs as the atheme user, so the config is its $HOME/.msmtprc
# (HOME=/atheme). The SMTP password is NOT written to the file —
# passwordeval reads SMTP_PASSWORD from the environment at send time.
# SMTP_* env names are shared with the api service: one Brevo/relay
# account can serve both.
SMTP_HOST=${SMTP_HOST:-mailpit}
SMTP_PORT=${SMTP_PORT:-1025}
SMTP_SECURITY=${SMTP_SECURITY:-none}
SMTP_USER=${SMTP_USER:-}

# MAIL_FROM may be "Name <addr>" — msmtp wants a bare address.
MAIL_FROM=${MAIL_FROM:-a09f <no-reply@a09f.invalid>}
if printf '%s' "$MAIL_FROM" | grep -q '<'; then
    MAIL_FROM=$(printf '%s' "$MAIL_FROM" | sed 's/.*<//; s/>.*//')
fi

{
    echo "account default"
    echo "host $SMTP_HOST"
    echo "port $SMTP_PORT"
    echo "from $MAIL_FROM"
    case "$SMTP_SECURITY" in
        ssl)      echo "tls on";        echo "tls_starttls off" ;;
        starttls) echo "tls on";        echo "tls_starttls on"  ;;
        *)        echo "tls off";       echo "tls_starttls off" ;;
    esac
    if [ -n "$SMTP_USER" ]; then
        echo "auth on"
        echo "user $SMTP_USER"
        echo 'passwordeval "printenv SMTP_PASSWORD"'
    else
        echo "auth off"
    fi
} > /atheme/.msmtprc
chmod 600 /atheme/.msmtprc

exec /entrypoint.sh
