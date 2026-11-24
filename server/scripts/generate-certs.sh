#!/bin/sh
# Regenerate self-signed TLS certificates for solanum and soju.
# SANs cover the advertised hostname plus localhost/127.0.0.1 so clients
# *can* verify if they choose to trust the cert (dev only — no CA).
set -eu
cd "$(dirname "$0")/.."

SAN="DNS:irc.solanum.test,DNS:localhost,IP:127.0.0.1"
DAYS=3650

gen() {
    dir=$1; cn=$2
    openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout "$dir/tls-key.pem" -out "$dir/tls-cert.pem" \
        -days "$DAYS" -subj "/CN=$cn" \
        -addext "subjectAltName=$SAN"
    chmod 600 "$dir/tls-key.pem"
    chmod 644 "$dir/tls-cert.pem"
}

gen solanum/etc irc.solanum.test
mv solanum/etc/tls-key.pem solanum/etc/ssl-key.pem
mv solanum/etc/tls-cert.pem solanum/etc/ssl-cert.pem
chmod 600 solanum/etc/ssl-key.pem
chmod 644 solanum/etc/ssl-cert.pem

openssl dhparam -out solanum/etc/dh.pem 2048
chmod 644 solanum/etc/dh.pem

gen soju irc.solanum.test
chmod 600 soju/tls-key.pem
chmod 644 soju/tls-cert.pem

echo "certs regenerated (self-signed, SAN: $SAN)"
