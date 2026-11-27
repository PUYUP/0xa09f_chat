#!/bin/sh
# Regenerate TLS material: a local root CA plus CA-signed server certificates
# for solanum and soju.
#
# soju verifies upstream certificates (ircs://), so solanum's cert must chain
# to a CA soju trusts — we mount pki/ca.pem into the soju container and point
# Go's crypto/x509 at it with SSL_CERT_FILE. soju's own downstream cert is
# also CA-signed for consistency (clients still don't verify it).
#
# SANs cover the docker DNS name plus localhost/127.0.0.1/172.30.99.10 so
# direct TLS clients *can* verify if they trust pki/ca.pem.
set -eu
cd "$(dirname "$0")/.."

DAYS=3650
CA_DAYS=3650
SAN="DNS:irc.solanum.test,DNS:solanum,DNS:localhost,IP:127.0.0.1,IP:172.30.99.10"
EXT_SRV=/tmp/solnet-srv.ext

mkdir -p pki

cat > "$EXT_SRV" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EOF

# --- root CA (only created once; delete pki/ to rotate the whole PKI) -------
if [ ! -f pki/ca.pem ]; then
    openssl req -x509 -newkey rsa:4096 -nodes \
        -keyout pki/ca-key.pem -out pki/ca.pem \
        -days "$CA_DAYS" -subj "/CN=SolNet Local CA" \
        -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
        -addext "keyUsage=critical,keyCertSign,cRLSign"
    chmod 600 pki/ca-key.pem
    chmod 644 pki/ca.pem
fi

# --- CA-signed server certs --------------------------------------------------
gen() {
    dir=$1; cn=$2; cert=$3; key=$4
    openssl req -newkey rsa:2048 -nodes \
        -keyout "$dir/$key" -out "/tmp/solnet-$cn.csr" \
        -subj "/CN=$cn"
    openssl x509 -req -in "/tmp/solnet-$cn.csr" \
        -CA pki/ca.pem -CAkey pki/ca-key.pem -CAcreateserial \
        -out "$dir/$cert" -days "$DAYS" -extfile "$EXT_SRV"
    rm -f "/tmp/solnet-$cn.csr"
    chmod 600 "$dir/$key"
    chmod 644 "$dir/$cert"
}

gen solanum/etc irc.solanum.test ssl-cert.pem ssl-key.pem
gen soju irc.solanum.test tls-cert.pem tls-key.pem

openssl dhparam -out solanum/etc/dh.pem 2048
chmod 644 solanum/etc/dh.pem

rm -f "$EXT_SRV" pki/ca.srl

echo "certs regenerated (CA-signed by pki/ca.pem, SAN: $SAN)"
