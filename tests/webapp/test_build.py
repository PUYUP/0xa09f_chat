#!/usr/bin/env python3
"""Webapp build for Cloudflare Workers (webapp/deploy.sh --dry-run): the files
in webapp/public/ point at production, scripts carry a release tag, security
headers are there, and in headless Chrome the built page talks only to
irc.snailog.com — a ?irc=… link can't send passwords elsewhere. The dev
copy (desktop/ui/) must still accept that override.

Needs Google Chrome for the browser part (or set CHROME=…); no server, no
Cloudflare account."""

import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from snailog import Check  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PUBLIC = os.path.join(ROOT, "webapp", "public")
CHROME = os.environ.get("CHROME") or next(
    (p for p in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                 shutil.which("google-chrome") or "", shutil.which("chromium") or "") if p and os.path.exists(p)), None)

# Loaded last: records where the app would send account requests and which
# WebSocket the shim opens, without connecting anywhere.
PROBE = """<script>
window.onerror = (m, s, l) => document.documentElement.setAttribute("data-err", m + " @" + l);
window.WebSocket = function (url) { document.documentElement.setAttribute("data-ws", url); throw new Error("probe"); };
</script>"""
AFTER = """<script>
document.documentElement.setAttribute("data-acct", ACCOUNT_URL);
window.__TAURI__.core.invoke("connect").catch(() => {});
</script>"""

check = Check("webapp build (Cloudflare Workers)")


def read(name):
    with open(os.path.join(PUBLIC, name)) as f:
        return f.read()


r = subprocess.run([os.path.join(ROOT, "webapp", "deploy.sh"), "--dry-run"], capture_output=True, text=True)
check("deploy.sh --dry-run succeeds", r.returncode == 0, r.stderr.strip())
if r.returncode:
    check.done()

files = sorted(os.listdir(PUBLIC))
check("public/ has exactly the webapp files",
      files == ["_headers", "app.js", "config.js", "index.html", "snail.png", "web-shim.js"], files)

cfg = read("config.js")
check("config: account service is https://irc.snailog.com", '"https://irc.snailog.com"' in cfg)
check("config: WebSocket is wss://irc.snailog.com/socket", '"wss://irc.snailog.com/socket"' in cfg)
check("config: WebSocket override is off", "allowWsOverride: false" in cfg)

html = read("index.html")
tags = re.findall(r'<script src="([^"]+)"></script>', html)
check("index.html loads config.js, then web-shim.js, then app.js",
      [t.split("?")[0] for t in tags] == ["config.js", "web-shim.js", "app.js"], tags)
check("web-shim.js and app.js carry a release tag", all("?v=" in t for t in tags[1:]), tags)

hdr = read("_headers")
for h in ("Strict-Transport-Security", "X-Content-Type-Options", "Content-Security-Policy",
          "frame-ancestors 'none'", "wss://irc.snailog.com"):
    check(f"_headers: {h}", h in hdr)

with open(os.path.join(ROOT, "webapp", "wrangler.jsonc")) as f:
    wr = f.read()
check("wrangler: assets from ./public, custom domain im.snailog.com",
      '"./public"' in wr and '"im.snailog.com"' in wr and '"custom_domain": true' in wr)


def probe(src_dir):
    """Copy a UI folder, add the probe, open it with ?irc=<evil>; return the root element's attributes."""
    work = tempfile.mkdtemp(prefix="snailog-webapp-")
    try:
        for f in os.listdir(src_dir):
            if os.path.isfile(os.path.join(src_dir, f)):
                shutil.copy(os.path.join(src_dir, f), work)
        with open(os.path.join(work, "index.html")) as f:
            page = f.read()
        page = page.replace("<head>", "<head>" + PROBE, 1)
        page = re.sub(r'(<script src="app\.js[^"]*"></script>)', lambda m: m.group(1) + AFTER, page, count=1)
        with open(os.path.join(work, "index.html"), "w") as f:
            f.write(page)
        out = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--dump-dom",
                              f"file://{work}/index.html?irc=ws://evil.example/socket"],
                             capture_output=True, text=True, timeout=60).stdout
        m = re.search(r"<html[^>]*>", out) or [""]
        return dict(re.findall(r'(data-\w+)="([^"]*)"', m[0]))
    finally:
        shutil.rmtree(work, ignore_errors=True)


if not CHROME:
    check.skip("built page in Chrome", "Google Chrome not found (set CHROME=…)")
else:
    a = probe(PUBLIC)
    check("built page: no JavaScript errors", "data-err" not in a, a.get("data-err"))
    check("built page: account requests go to https://irc.snailog.com",
          a.get("data-acct") == "https://irc.snailog.com", a.get("data-acct"))
    check("built page: ?irc=… is ignored, WebSocket goes to wss://irc.snailog.com/socket",
          a.get("data-ws") == "wss://irc.snailog.com/socket", a.get("data-ws"))
    d = probe(os.path.join(ROOT, "desktop", "ui"))
    check("dev page: ?irc=… still overrides the WebSocket",
          d.get("data-ws") == "ws://evil.example/socket", d.get("data-ws"))
    check("dev page: account service stays local", d.get("data-acct") == "http://127.0.0.1:16680", d.get("data-acct"))

check.done()
