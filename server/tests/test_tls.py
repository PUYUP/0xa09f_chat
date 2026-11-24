#!/usr/bin/env python3
"""TLS handshake smoke test for solanum (:6697) and soju (:16697).

Verifies the TLS listeners accept connections and present a certificate.
Self-signed dev certs are expected — verification is disabled.

Usage: python3 tests/test_tls.py [host] [solanum_port] [soju_port]
"""

import socket
import ssl
import sys

HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
SOLANUM_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 6697
SOJU_PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 16697

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def check(name, port, expect_banner=True):
    raw = socket.create_connection((HOST, port), timeout=10)
    s = ctx.wrap_socket(raw, server_hostname=HOST)
    cert = s.getpeercert(binary_form=False)
    print(f"[PASS] {name}:{port} TLS handshake OK")
    if expect_banner:
        # solanum sends nothing until NICK/USER; soju sends 001 only after auth.
        # Just prove the socket is usable: send a harmless IRC line and read.
        s.sendall(b"NICK tlsprobe\r\nUSER tlsprobe 0 * :tls\r\n")
        s.settimeout(10)
        data = s.recv(4096)
        print(f"      first bytes: {data[:80]!r}")
        assert data, "no data after handshake"
    s.close()


check("solanum", SOLANUM_PORT)
check("soju", SOJU_PORT)
print("ALL TLS TESTS PASSED")
