#!/usr/bin/env python3
"""Production .env (server/.env.production.example + scripts/gen-prod-env.sh):
every password is generated, unique and safe for sed/pgpass; the file is
private; an existing .env is never overwritten; nothing is exposed beyond
localhost; and every setting docker-compose.yml reads is covered.
Offline: no docker, no server."""

import os
import re
import stat
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from snailog import Check  # noqa: E402

SERVER = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "server"))
SCRIPT = os.path.join(SERVER, "scripts", "gen-prod-env.sh")
PASSWORDS = ["LINK_SOLANUM_SEND", "LINK_SOLANUM_ACCEPT", "OPER_ADMIN_PASSWORD",
             "POSTGRES_PASSWORD", "SNAILOG_DB_PASSWORD", "LOBBY_OWNER_PASSWORD"]

check = Check("production .env")
tmp = tempfile.mkdtemp(prefix="snailog-env-")
out = os.path.join(tmp, ".env")

r = subprocess.run([SCRIPT, out], capture_output=True, text=True)
check("gen-prod-env.sh succeeds", r.returncode == 0, r.stderr.strip())
if r.returncode:
    check.done()

text = open(out).read()
env = dict(l.split("=", 1) for l in text.splitlines() if l and not l.startswith("#") and "=" in l)

check("file is private (mode 600)", stat.S_IMODE(os.stat(out).st_mode) == 0o600, oct(os.stat(out).st_mode))
check("no __RANDOM__ value left", not [k for k, v in env.items() if v == "__RANDOM__"])
vals = [env.get(k, "") for k in PASSWORDS]
check("every password is 48 hex chars (safe for sed '|' and pgpass ':')",
      all(re.fullmatch(r"[0-9a-f]{48}", v) for v in vals), vals)
check("every password is different", len(set(vals)) == len(vals))
check("passwords are not printed", not any(v in r.stdout for v in vals))
check("output lists the SMTP fields still to fill in", "line" in r.stdout and "SOJU_USER" in r.stdout, r.stdout)

r2 = subprocess.run([SCRIPT, out], capture_output=True, text=True)
check("refuses to overwrite an existing file", r2.returncode != 0 and open(out).read() == text)

inline = [l for l in text.splitlines() if not l.startswith("#") and re.search(r"=.*\s#", l)]
check("no inline comments (setup-rooms.py/monitor.sh read raw values)", not inline, inline)
check("all ports bound to localhost",
      all(env.get(k) == "127.0.0.1" for k in ("BIND_ADDR", "SOLANUM_BIND", "SOJU_BIND")),
      {k: env.get(k) for k in ("BIND_ADDR", "SOLANUM_BIND", "SOJU_BIND")})
check("real SMTP, sender @snailog.com",
      env.get("SMTP_HOST") not in ("", "mailpit") and "@snailog.com" in env.get("MAIL_FROM", ""))
check("TRUSTED_PROXIES set", bool(env.get("TRUSTED_PROXIES")))
check("no dev test password", "SOJU_PASSWORD" not in env)

compose = open(os.path.join(SERVER, "docker-compose.yml")).read()
needed = sorted(set(re.findall(r"\$\{(\w+)(?::-[^}]*)?\}", compose)) - {"SOLANUM_COMMIT"})
missing = [k for k in needed if k not in env]
check("covers every variable docker-compose.yml reads", not missing, missing)

subprocess.run(["rm", "-rf", tmp])
check.done()
