#!/bin/sh
# Render atheme.conf + ~/.msmtprc from the templates/env, then delegate to
# the image's own entrypoint which performs writability checks and starts
# atheme-services.
set -e

# Link passwords come from docker secrets (/run/secrets/<name>, generated
# from .env by scripts/sync-secrets.sh); env vars are the fallback.
for pair in link-solanum-send:LINK_SOLANUM_SEND \
            link-solanum-accept:LINK_SOLANUM_ACCEPT; do
    file=${pair%%:*}; var=${pair##*:}
    if [ -s "/run/secrets/$file" ]; then
        eval "$var=\$(tr -d ' \t\r\n' < /run/secrets/$file)"
    fi
done

sed -e "s|__LINK_SOLANUM_SEND__|${LINK_SOLANUM_SEND:-}|g" \
    -e "s|__LINK_SOLANUM_ACCEPT__|${LINK_SOLANUM_ACCEPT:-}|g" \
    /atheme/etc/atheme.conf.tmpl > /atheme/etc/atheme.conf

# msmtp is the sendmail-compatible MTA atheme calls (mta = "/usr/bin/msmtp").
# It runs as the atheme user, so the config is its $HOME/.msmtprc
# (HOME=/atheme). The SMTP password is NOT written to the file — passwordeval
# reads it at send time, from the docker secret when mounted, else the
# SMTP_PASSWORD env var.
# SMTP_* env names are shared with the api service: one Brevo/relay
# account can serve both.
SMTP_HOST=${SMTP_HOST:-mailpit}
SMTP_PORT=${SMTP_PORT:-1025}
SMTP_SECURITY=${SMTP_SECURITY:-none}
SMTP_USER=${SMTP_USER:-}
if [ -s /run/secrets/smtp-password ]; then
    SMTP_PASSWORD_EVAL='passwordeval "cat /run/secrets/smtp-password"'
else
    SMTP_PASSWORD_EVAL='passwordeval "printenv SMTP_PASSWORD"'
fi

# MAIL_FROM may be "Name <addr>" — msmtp wants a bare address.
MAIL_FROM=${MAIL_FROM:-snailog <no-reply@snailog.invalid>}
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
        echo "$SMTP_PASSWORD_EVAL"
    else
        echo "auth off"
    fi
} > /atheme/.msmtprc
chmod 600 /atheme/.msmtprc

exec /entrypoint.sh
