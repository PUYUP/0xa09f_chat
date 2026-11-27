#!/bin/sh
# Deploy the webapp (desktop/ui/) to Cloudflare Workers at im.snailog.com.
#
#   ./webapp/deploy.sh            build public/ and deploy
#   ./webapp/deploy.sh --dry-run  build public/ only (check it before deploying)
#
# First time: `npx wrangler login`. Rollback: `cd webapp && npx wrangler rollback`.
set -eu
cd "$(dirname "$0")"
UI=../desktop/ui

# Release tag for cache busting: the commit, plus "-dirty" for uncommitted changes.
VER=$(git rev-parse --short HEAD 2>/dev/null || date +%s)
if ! git diff --quiet HEAD -- "$UI" . 2>/dev/null; then VER="$VER-dirty"; fi

rm -rf public && mkdir public
cp "$UI/index.html" "$UI/app.js" "$UI/web-shim.js" "$UI/snail.png" public/
cp config.js _headers public/        # production endpoints + security headers

# app.js?v=… so a new release never runs against an old cached app.js.
sed -i.bak \
  -e "s|<script src=\"web-shim.js\"></script>|<script src=\"web-shim.js?v=$VER\"></script>|" \
  -e "s|<script src=\"app.js\"></script>|<script src=\"app.js?v=$VER\"></script>|" \
  public/index.html
rm public/index.html.bak
grep -q "app.js?v=$VER" public/index.html || { echo "index.html: app.js script tag not found" >&2; exit 1; }
grep -q 'src="config.js"' public/index.html || { echo "index.html: config.js script tag not found" >&2; exit 1; }

echo "public/ ready (release $VER):"
ls -1 public
[ "${1:-}" = "--dry-run" ] && exit 0

npx wrangler deploy
