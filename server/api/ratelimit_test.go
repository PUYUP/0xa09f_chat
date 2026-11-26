package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Addresses rotate for free, so the unit a limit counts against must be the
// network: a subscriber's whole /64, one IPv4 address.
func TestNetKey(t *testing.T) {
	cases := map[string]string{
		"1.2.3.4":              "1.2.3.4",
		"::ffff:1.2.3.4":       "1.2.3.4",
		"::ffff:127.0.0.1":     "127.0.0.1",
		"2001:db8:1:2::1":      "2001:db8:1:2::/64",
		"2001:db8:1:2:ffff::9": "2001:db8:1:2::/64",
		"2001:db8:1:3::1":      "2001:db8:1:3::/64",
		"[2001:db8::5]":        "2001:db8::/64",
		"not-an-address":       "not-an-address",
		"":                     "",
	}
	for in, want := range cases {
		if got := netKey(in); got != want {
			t.Errorf("netKey(%q) = %q, want %q", in, got, want)
		}
	}
}

// Two addresses of one /64 must share a bucket: that is the bypass this closes.
func TestNetKeyGroupsOneSubnet(t *testing.T) {
	a, b := netKey("2001:db8:aa:bb::1"), netKey("2001:db8:aa:bb:1234:5678:9abc:def0")
	if a != b {
		t.Fatalf("addresses of one /64 got different keys: %q vs %q", a, b)
	}
}

func newTestServer(proxies ...string) *server {
	cfg := config{trustedProxies: map[string]bool{}}
	for _, p := range proxies {
		cfg.trustedProxies[netKey(p)] = true
	}
	return &server{cfg: cfg}
}

func testReq(remote string, hdr map[string]string) *http.Request {
	r := httptest.NewRequest("POST", "/session", nil)
	r.RemoteAddr = remote
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	return r
}

func TestClientKeyIgnoresHeadersWithoutTrustedProxy(t *testing.T) {
	s := newTestServer()
	r := testReq("1.2.3.4:5555", map[string]string{
		"X-Forwarded-For": "9.9.9.9",
		"X-Real-IP":       "8.8.8.8",
	})
	if got := s.clientKey(r); got != "1.2.3.4" {
		t.Fatalf("clientKey = %q, want the peer address (headers must not pick the bucket)", got)
	}
}

func TestClientKeyBehindTrustedProxy(t *testing.T) {
	s := newTestServer("127.0.0.1")
	// The proxy appends its own hop; the client is the right-most non-proxy.
	r := testReq("127.0.0.1:4000", map[string]string{
		"X-Forwarded-For": "6.6.6.6, 2001:db8::7, 127.0.0.1",
	})
	if got := s.clientKey(r); got != "2001:db8::/64" {
		t.Fatalf("clientKey = %q, want 2001:db8::/64", got)
	}
	// A hop that lies about being loopback is still skipped, not trusted.
	r = testReq("127.0.0.1:4000", map[string]string{"X-Forwarded-For": "5.5.5.5, 127.0.0.2"})
	if got := s.clientKey(r); got != "5.5.5.5" {
		t.Fatalf("clientKey = %q, want 5.5.5.5", got)
	}
	// No header at all: the proxy's own address is the best we have.
	r = testReq("127.0.0.1:4000", nil)
	if got := s.clientKey(r); got != "127.0.0.1" {
		t.Fatalf("clientKey = %q, want 127.0.0.1", got)
	}
}

// An IPv6 loopback is one machine, so it is not folded into a shared /64 (a
// local proxy would otherwise be "everyone in ::/64").
func TestNetKeyLoopback(t *testing.T) {
	if got := netKey("::1"); got != "::1" {
		t.Fatalf("netKey(::1) = %q, want ::1", got)
	}
	if got := netKey("127.0.0.1"); got != "127.0.0.1" {
		t.Fatalf("netKey(127.0.0.1) = %q, want 127.0.0.1", got)
	}
}
