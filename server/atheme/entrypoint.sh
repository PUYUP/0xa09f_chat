#!/bin/sh
# Render atheme.conf from the template (secrets via env), then delegate to
# the image's own entrypoint which performs writability checks and starts
# atheme-services.
set -e

sed -e "s|__LINK_SOLANUM_SEND__|${LINK_SOLANUM_SEND:-}|g" \
    -e "s|__LINK_SOLANUM_ACCEPT__|${LINK_SOLANUM_ACCEPT:-}|g" \
    /atheme/etc/atheme.conf.tmpl > /atheme/etc/atheme.conf

exec /entrypoint.sh
