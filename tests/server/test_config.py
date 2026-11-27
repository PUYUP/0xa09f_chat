#!/usr/bin/env python3
"""Static config regression tests — no server needed.

Guards the security-sensitive invariants that broke (or almost broke) once:
- operator password must never be a literal in ircd.conf.tmpl
- the soju auth block must precede the "*@*" catch-all (first-match-wins:
  a later block is ignored — this made need_ident dead code once)
- mailpit must stay on 127.0.0.1 (it displays password-reset emails)
- entrypoint must render OPER_ADMIN_PASSWORD and refuse leftover placeholders

Usage: python3 tests/server/test_config.py
"""

import re
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2] / "server"
failures = []


def check(name, ok, detail=""):
    print(("[PASS] " if ok else "[FAIL] ") + name + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(name)


# --- solanum template -------------------------------------------------------
tmpl = (SERVER / "solanum/etc/ircd.conf.tmpl").read_text()
entry = (SERVER / "solanum/entrypoint.sh").read_text()
compose = (SERVER / "docker-compose.yml").read_text()
atheme = (SERVER / "atheme/etc/atheme.conf.tmpl").read_text()

check("oper password is a placeholder, not a hash",
      "__OPER_ADMIN_PASSWORD__" in tmpl and not re.search(r'password\s*=\s*"\$6\$', tmpl))

# first-match-wins: the soju-specific auth block must appear before *@*
soju_block = tmpl.find("user = \"*@__SOJU_HOST__\"")
catchall = tmpl.find('user = "*@*"')
check("soju auth block precedes *@* catch-all",
      0 < soju_block < catchall,
      f"soju@{soju_block} catchall@{catchall}")

check("entrypoint hashes OPER_ADMIN_PASSWORD",
      "OPER_ADMIN_PASSWORD" in entry and "openssl passwd -6" in entry)
check("entrypoint refuses unreplaced placeholders",
      "__[A-Z_]*__" in entry)

# TLS enforcement: every auth block must require SSL, and the plaintext-only
# soju port (16668) must stay gone — upstreams use ircs://solanum:6697.
check("need_ssl on all auth blocks",
      tmpl.count("need_ssl") >= 2)
check("no plaintext-only 16668 listener",
      "port = 16668" not in tmpl and "16668" not in compose)
check("soju trusts the local CA for upstream TLS",
      "SSL_CERT_FILE: /pki/ca.pem" in compose and "./pki:/pki:ro" in compose)
check("api upstream template is TLS",
      "ircs://solanum:6697" in compose)

# --- secrets & link isolation -------------------------------------------------
# Passwords must reach containers as docker secrets (/run/secrets), never as
# env vars — env shows up in `docker inspect`.
check("no env_file in compose (secrets stay out of env)",
      "env_file" not in compose)
check("compose declares the password secrets",
      all(s in compose for s in (
          "link-solanum-send", "link-solanum-accept", "oper-admin-password",
          "postgres-password", "snailog-db-password", "smtp-password", "pgpass")))
check("postgres uses POSTGRES_PASSWORD_FILE",
      "POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password" in compose)
check("soju uses PGPASSFILE, not PGPASSWORD",
      "PGPASSFILE: /run/secrets/pgpass" in compose
      and "PGPASSWORD" not in compose)
check("api DATABASE_URL carries no password",
      "postgres://snailog@postgres" in compose
      and "DB_PASSWORD_FILE: /run/secrets/snailog-db-password" in compose)
check("secret files are gitignored",
      "server/secrets/*" in (Path(__file__).resolve().parents[2] / ".gitignore").read_text())

# Atheme cannot do TLS server links — the link is isolated on a dedicated
# docker network that only solanum+atheme join.
check("irc-link network is internal and only solanum+atheme join",
      "internal: true" in compose and "irc-link:" in compose
      and compose.count("irc-link:") >= 3)  # network def + 2 service attachments
check("atheme uplink targets the irc-link IP, not ircnet",
      'host = "172.31.99.10"' in atheme
      and 'host = "solanum"' not in atheme.split('uplink "irc.solanum.test"')[1].split('};')[0])

# --- compose -----------------------------------------------------------------
mailpit = re.search(r"mailpit:.*?ports:\s*\n(.*?)\n\s*\n", compose, re.S)
check("mailpit binds 127.0.0.1 only",
      mailpit and '"127.0.0.1:${MAILPIT_PORT' in mailpit.group(1),
      mailpit.group(1).strip()[:120] if mailpit else "no mailpit block")

# --- atheme -------------------------------------------------------------------
check("httpd/xmlrpc modules disabled",
      '#loadmodule "modules/misc/httpd"' in atheme
      and '#loadmodule "modules/transport/xmlrpc"' in atheme)
check("dormant operator block removed",
      'operator "jilles" {' not in atheme)
check("email password-recovery modules disabled",
      '#loadmodule "modules/nickserv/resetpass"' in atheme
      and '#loadmodule "modules/nickserv/setpass"' in atheme
      and '#loadmodule "modules/nickserv/sendpass_user"' in atheme)

# An unterminated /* comment once swallowed every NickServ SET module
# (set_core..vhost) — services ran fine but NS SET PROPERTY was dead.
# (Raw counts of /* vs */ lie: both appear inside comment text, so scan
# for a comment still open at EOF instead.)
i, _line, _start, unclosed = 0, 1, None, None
while i < len(atheme) - 1:
    if atheme[i] == "\n":
        _line += 1
    if atheme[i:i+2] == "/*" and _start is None:
        _start = _line
        i += 2
        continue
    if atheme[i:i+2] == "*/" and _start is not None:
        _start = None
        i += 2
        continue
    i += 1
unclosed = _start
check("no unterminated block comment in atheme.conf.tmpl",
      unclosed is None, f"comment opened at line {unclosed} never closed")
atheme_code = re.sub(r"/\*.*?\*/", "", atheme, flags=re.S)
check("nickserv SET modules not inside a comment",
      'loadmodule "modules/nickserv/set_core"' in atheme_code
      and 'loadmodule "modules/nickserv/set_property"' in atheme_code
      and 'loadmodule "modules/nickserv/taxonomy"' in atheme_code)

print()
if failures:
    print(f"{len(failures)} FAILURES: {', '.join(failures)}")
    sys.exit(1)
print("ALL CONFIG TESTS PASSED")
