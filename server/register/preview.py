"""Link previews for the a09f app: title, description and image of a URL.

The service fetches pages on behalf of users, so it must not become a way to
reach internal machines (SSRF). Every hop is checked:
  * http/https only, default ports or 80/443/8080/8443;
  * the host is resolved here and EVERY address must be public (no private,
    loopback, link-local, multicast, reserved or the docker network);
  * the connection goes to that checked address (no second DNS lookup that
    could answer differently), with the original Host / SNI;
  * redirects are followed by hand (max 3), each checked the same way;
  * small timeouts and size caps; HTML only for pages, images only for
    thumbnails (the app loads thumbnails through /preview/img, so users'
    IPs never reach third-party sites).
"""

import html
import http.client
import ipaddress
import re
import socket
import ssl
import time
from urllib.parse import urljoin, urlsplit

ALLOWED_PORTS = {80, 443, 8080, 8443}
PAGE_MAX = 512 * 1024
IMAGE_MAX = 1024 * 1024
TIMEOUT = 5
MAX_REDIRECTS = 3
CACHE_TTL = 6 * 3600
UA = "a09f-link-preview/1.0"

_cache = {}           # url -> (at, result)


class PreviewError(Exception):
    pass


def _public_addrs(host, port):
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise PreviewError("host not found")
    addrs = []
    for family, _, _, _, sa in infos:
        ip = ipaddress.ip_address(sa[0].split("%")[0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved
                or ip.is_unspecified or not ip.is_global):
            raise PreviewError("address not allowed")
        addrs.append((family, sa[0]))
    if not addrs:
        raise PreviewError("host not found")
    return addrs


class _PinnedHTTPS(http.client.HTTPSConnection):
    """HTTPS to a pre-checked IP, with SNI/cert check for the real host name."""

    def __init__(self, ip, host, port):
        super().__init__(host, port, timeout=TIMEOUT, context=ssl.create_default_context())
        self._ip = ip

    def connect(self):
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, ip, host, port):
        super().__init__(host, port, timeout=TIMEOUT)
        self._ip = ip

    def connect(self):
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)


def _fetch(url, accept, limit):
    """GET url (following up to MAX_REDIRECTS checked redirects).
    Returns (final_url, content_type, body)."""
    for _ in range(MAX_REDIRECTS + 1):
        u = urlsplit(url)
        if u.scheme not in ("http", "https") or not u.hostname:
            raise PreviewError("not an http(s) link")
        port = u.port or (443 if u.scheme == "https" else 80)
        if port not in ALLOWED_PORTS:
            raise PreviewError("port not allowed")
        family, ip = _public_addrs(u.hostname, port)[0]
        conn = (_PinnedHTTPS if u.scheme == "https" else _PinnedHTTP)(ip, u.hostname, port)
        path = (u.path or "/") + (f"?{u.query}" if u.query else "")
        try:
            conn.request("GET", path, headers={"User-Agent": UA, "Accept": accept, "Accept-Encoding": "identity"})
            r = conn.getresponse()
            if r.status in (301, 302, 303, 307, 308):
                loc = r.getheader("Location")
                if not loc:
                    raise PreviewError("bad redirect")
                url = urljoin(url, loc)
                continue
            if r.status != 200:
                raise PreviewError(f"HTTP {r.status}")
            ctype = (r.getheader("Content-Type") or "").split(";")[0].strip().lower()
            body = r.read(limit + 1)
            if len(body) > limit:
                body = body[:limit]
            return url, ctype, body
        except (OSError, http.client.HTTPException, ssl.SSLError) as e:
            raise PreviewError(f"fetch failed: {e.__class__.__name__}")
        finally:
            conn.close()
    raise PreviewError("too many redirects")


_META = re.compile(r"<meta\s[^>]*?>", re.I | re.S)
_ATTR = re.compile(r'([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|\'([^\']*)\'|([^\s>]+))')


def _parse(page_url, raw):
    text = raw.decode("utf-8", "replace")
    head = text[: text.lower().find("</head>")] if "</head>" in text.lower() else text[:200000]
    meta = {}
    for tag in _META.findall(head):
        attrs = {k.lower(): (v1 or v2 or v3) for k, _, v1, v2, v3 in _ATTR.findall(tag)}
        key = (attrs.get("property") or attrs.get("name") or "").lower()
        if key and "content" in attrs and key not in meta:
            meta[key] = html.unescape(attrs["content"]).strip()
    title = meta.get("og:title") or meta.get("twitter:title")
    if not title:
        m = re.search(r"<title[^>]*>(.*?)</title>", head, re.I | re.S)
        title = html.unescape(" ".join(m.group(1).split())) if m else ""
    desc = meta.get("og:description") or meta.get("twitter:description") or meta.get("description") or ""
    image = meta.get("og:image") or meta.get("twitter:image") or ""
    if image:
        image = urljoin(page_url, image)
        if urlsplit(image).scheme not in ("http", "https"):
            image = ""
    site = meta.get("og:site_name") or urlsplit(page_url).hostname or ""
    return {"url": page_url, "title": title[:200], "description": " ".join(desc.split())[:300],
            "image": image, "site": site[:80]}


def preview(url):
    url = str(url or "").strip()[:2000]
    hit = _cache.get(url)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    final, ctype, body = _fetch(url, "text/html,application/xhtml+xml", PAGE_MAX)
    if ctype not in ("text/html", "application/xhtml+xml"):
        raise PreviewError("not a web page")
    result = _parse(final, body)
    if not result["title"] and not result["description"]:
        raise PreviewError("nothing to show")
    if len(_cache) > 2000:
        _cache.clear()
    _cache[url] = (time.time(), result)
    return result


def image(url):
    _, ctype, body = _fetch(url, "image/*", IMAGE_MAX)
    if ctype not in ("image/jpeg", "image/png", "image/gif", "image/webp"):
        raise PreviewError("not an image")
    if len(body) >= IMAGE_MAX:
        raise PreviewError("image too large")
    return ctype, body
