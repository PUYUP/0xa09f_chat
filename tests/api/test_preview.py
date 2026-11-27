#!/usr/bin/env python3
"""Link previews: public pages work, every way of reaching internal
machines (SSRF) is refused. Needs internet access for the public cases."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from snailog import Api, Check  # noqa: E402
from urllib.parse import quote  # noqa: E402

check = Check("link previews + SSRF guard")
a = Api("jack")

r = a.get("/preview?url=" + quote("https://example.com", safe=""))
check("public page: title", r.get("title") == "Example Domain", r)

blocked = [
    "http://127.0.0.1:16680/health",       # the account service itself
    "http://localhost:8080/health",
    "http://soju:6667/",                    # docker service names
    "http://register:8080/health",
    "http://172.30.99.30/",                 # docker network
    "http://169.254.169.254/latest/meta-data/",   # cloud metadata
    "http://10.0.0.1/", "http://192.168.1.1/", "http://[::1]/",
    "file:///etc/passwd", "ftp://example.com/", "gopher://example.com/",
    "https://example.com:22/",              # non-web port
]
for u in blocked:
    r = a.get("/preview?url=" + quote(u, safe=""))
    check(f"refused: {u}", not r.get("ok"), r)

check.done()
