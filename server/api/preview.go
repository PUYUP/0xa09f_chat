package main

// Link previews: title, description and image of a URL.
//
// The service fetches pages on behalf of users, so it must not become a way
// to reach internal machines (SSRF). Every hop is checked:
//   - http/https only, ports 80/443/8080/8443;
//   - the host is resolved here and EVERY address must be public (no
//     private, loopback, link-local, multicast, reserved, unspecified);
//   - the connection goes to that checked address (no second DNS lookup that
//     could answer differently), with the original Host / SNI and normal
//     certificate checks;
//   - redirects are followed by hand (max 3), each checked the same way;
//   - small timeouts and size caps; HTML only for pages, images only for
//     thumbnails (the app loads thumbnails through /preview/img, so users'
//     IPs never reach third-party sites).

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	pageMax      = 512 * 1024
	imageMax     = 1024 * 1024
	fetchTimeout = 5 * time.Second
	maxRedirects = 3
	previewTTL   = 6 * time.Hour
	previewUA    = "a09f-link-preview/1.0"
	maxPreviews  = 30 // per user per minute
)

var allowedPorts = map[string]bool{"80": true, "443": true, "8080": true, "8443": true}

type previewError struct{ msg string }

func (e *previewError) Error() string { return e.msg }

func perr(msg string) error { return &previewError{msg} }

type previewResult struct {
	URL         string `json:"url"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Image       string `json:"image"`
	Site        string `json:"site"`
}

type previewer struct {
	mu    sync.Mutex
	cache map[string]previewHit
}

type previewHit struct {
	at  time.Time
	res previewResult
}

func newPreviewer() *previewer { return &previewer{cache: map[string]previewHit{}} }

// publicAddr resolves host and returns its first address if ALL are public.
func publicAddr(ctx context.Context, host string) (netip.Addr, error) {
	if a, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		if !isPublic(a) {
			return netip.Addr{}, perr("address not allowed")
		}
		return a, nil
	}
	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(addrs) == 0 {
		return netip.Addr{}, perr("host not found")
	}
	for _, a := range addrs {
		if !isPublic(a) {
			return netip.Addr{}, perr("address not allowed")
		}
	}
	return addrs[0], nil
}

var nonGlobal = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("255.255.255.255/32"),
	netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("100::/64"), netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("fc00::/7"),
}

func isPublic(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() || a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() ||
		a.IsMulticast() || a.IsUnspecified() || a.IsInterfaceLocalMulticast() || !a.IsGlobalUnicast() {
		return false
	}
	for _, p := range nonGlobal {
		if p.Contains(a) {
			return false
		}
	}
	return true
}

// fetch GETs a URL, following up to maxRedirects checked redirects.
// Returns the final URL, content type and (capped) body.
func fetch(ctx context.Context, raw, accept string, limit int) (string, string, []byte, error) {
	for hop := 0; hop <= maxRedirects; hop++ {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
			return "", "", nil, perr("not an http(s) link")
		}
		port := u.Port()
		if port == "" {
			port = map[string]string{"http": "80", "https": "443"}[u.Scheme]
		}
		if !allowedPorts[port] {
			return "", "", nil, perr("port not allowed")
		}
		ip, err := publicAddr(ctx, u.Hostname())
		if err != nil {
			return "", "", nil, err
		}
		pinned := net.JoinHostPort(ip.String(), port)
		dialer := &net.Dialer{Timeout: fetchTimeout}
		tr := &http.Transport{
			// Always the checked address, whatever the request says.
			DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, "tcp", pinned)
			},
			TLSClientConfig:       &tls.Config{ServerName: u.Hostname()},
			TLSHandshakeTimeout:   fetchTimeout,
			ResponseHeaderTimeout: fetchTimeout,
			DisableKeepAlives:     true,
			Proxy:                 nil,
		}
		client := &http.Client{
			Transport:     tr,
			Timeout:       2 * fetchTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
		r, _ := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
		r.Header.Set("User-Agent", previewUA)
		r.Header.Set("Accept", accept)
		r.Header.Set("Accept-Encoding", "identity")
		resp, err := client.Do(r)
		if err != nil {
			return "", "", nil, perr("fetch failed")
		}
		switch resp.StatusCode {
		case 301, 302, 303, 307, 308:
			loc := resp.Header.Get("Location")
			resp.Body.Close()
			if loc == "" {
				return "", "", nil, perr("bad redirect")
			}
			next, err := u.Parse(loc)
			if err != nil {
				return "", "", nil, perr("bad redirect")
			}
			raw = next.String()
			continue
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return "", "", nil, perr(fmt.Sprintf("HTTP %d", resp.StatusCode))
		}
		ctype := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
		body, err := io.ReadAll(io.LimitReader(resp.Body, int64(limit)+1))
		if err != nil && len(body) == 0 {
			return "", "", nil, perr("fetch failed")
		}
		return raw, ctype, body, nil
	}
	return "", "", nil, perr("too many redirects")
}

var (
	metaTagRe = regexp.MustCompile(`(?is)<meta\s[^>]*?>`)
	attrRe    = regexp.MustCompile(`([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))`)
	titleRe   = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
)

func parsePage(pageURL string, raw []byte) previewResult {
	text := strings.ToValidUTF8(string(raw), "�")
	head := text
	if i := strings.Index(strings.ToLower(text), "</head>"); i >= 0 {
		head = text[:i]
	} else if len(head) > 200000 {
		head = head[:200000]
	}
	meta := map[string]string{}
	for _, tag := range metaTagRe.FindAllString(head, -1) {
		attrs := map[string]string{}
		for _, m := range attrRe.FindAllStringSubmatch(tag, -1) {
			attrs[strings.ToLower(m[1])] = m[3] + m[4] + m[5]
		}
		key := strings.ToLower(attrs["property"])
		if key == "" {
			key = strings.ToLower(attrs["name"])
		}
		if c, ok := attrs["content"]; ok && key != "" {
			if _, seen := meta[key]; !seen {
				meta[key] = strings.TrimSpace(html.UnescapeString(c))
			}
		}
	}
	first := func(keys ...string) string {
		for _, k := range keys {
			if v := meta[k]; v != "" {
				return v
			}
		}
		return ""
	}
	title := first("og:title", "twitter:title")
	if title == "" {
		if m := titleRe.FindStringSubmatch(head); m != nil {
			title = html.UnescapeString(squash(m[1]))
		}
	}
	desc := first("og:description", "twitter:description", "description")
	image := first("og:image", "twitter:image")
	base, _ := url.Parse(pageURL)
	if image != "" {
		if iu, err := base.Parse(image); err == nil && (iu.Scheme == "http" || iu.Scheme == "https") {
			image = iu.String()
		} else {
			image = ""
		}
	}
	site := first("og:site_name")
	if site == "" && base != nil {
		site = base.Hostname()
	}
	return previewResult{URL: pageURL, Title: cut(title, 200), Description: cut(squash(desc), 300), Image: image, Site: cut(site, 80)}
}

func (p *previewer) page(ctx context.Context, raw string) (previewResult, error) {
	raw = cut(strings.TrimSpace(raw), 2000)
	p.mu.Lock()
	hit, ok := p.cache[raw]
	p.mu.Unlock()
	if ok && time.Since(hit.at) < previewTTL {
		return hit.res, nil
	}
	final, ctype, body, err := fetch(ctx, raw, "text/html,application/xhtml+xml", pageMax)
	if err != nil {
		return previewResult{}, err
	}
	if ctype != "text/html" && ctype != "application/xhtml+xml" {
		return previewResult{}, perr("not a web page")
	}
	if len(body) > pageMax {
		body = body[:pageMax]
	}
	res := parsePage(final, body)
	if res.Title == "" && res.Description == "" {
		return previewResult{}, perr("nothing to show")
	}
	p.mu.Lock()
	if len(p.cache) > 2000 {
		p.cache = map[string]previewHit{}
	}
	p.cache[raw] = previewHit{time.Now(), res}
	p.mu.Unlock()
	return res, nil
}

func (p *previewer) image(ctx context.Context, raw string) (string, []byte, error) {
	_, ctype, body, err := fetch(ctx, raw, "image/*", imageMax)
	if err != nil {
		return "", nil, err
	}
	switch ctype {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
	default:
		return "", nil, perr("not an image")
	}
	if len(body) >= imageMax {
		return "", nil, perr("image too large")
	}
	return ctype, body, nil
}

// servePreview: GET /preview?url= (JSON) and GET /preview/img?u=&token=.
func (s *server) servePreview(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	token := q.Get("token")
	if token == "" {
		if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
			token = auth[7:]
		}
	}
	me := s.sess.user(r.Context(), token)
	if me == "" {
		writeErr(w, fail(401, "Please sign in again."))
		return
	}
	if !s.previews.take(me, maxPreviews) {
		writeErr(w, fail(429, "Too many previews."))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	var pe *previewError
	if r.URL.Path == "/preview" {
		res, err := s.preview.page(ctx, q.Get("url"))
		if errors.As(err, &pe) {
			writeErr(w, fail(422, "No preview: "+pe.msg))
			return
		} else if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, obj{"ok": true, "url": res.URL, "title": res.Title, "description": res.Description,
			"image": res.Image, "site": res.Site})
		return
	}
	ctype, data, err := s.preview.image(ctx, q.Get("u"))
	if errors.As(err, &pe) {
		writeErr(w, fail(422, "No preview: "+pe.msg))
		return
	} else if err != nil {
		writeErr(w, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("Cache-Control", "private, max-age=86400")
	h.Set("X-Content-Type-Options", "nosniff")
	cors(w)
	w.WriteHeader(200)
	w.Write(data)
}
