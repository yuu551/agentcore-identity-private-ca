#!/usr/bin/env bash
# 検証用のプライベートCAと、Keycloakのサーバー証明書を作る（OpenSSL 3.x 以降）
# OUT=certs-new ./certs.sh のように出力先を変えると、ローテーション用の新しいCAを作れる
set -euo pipefail
HOST=idp.internal.example.com
OUT=${OUT:-certs}
CA_NAME=${CA_NAME:-Demo Private Root CA}
mkdir -p "$OUT" && cd "$OUT"

# プライベートCA：basicConstraintsをCA:TRUEにして自己署名する
openssl genrsa -out ca.key 2048
openssl req -x509 -new -key ca.key -sha256 -days 3650 \
  -subj "/CN=$CA_NAME" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out ca.pem

# サーバー証明書：SANにKeycloakのホスト名を入れ、CAで署名する
openssl genrsa -out server.key 2048
openssl req -new -key server.key -subj "/CN=$HOST" -out server.csr
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -days 365 -sha256 \
  -extfile <(printf "subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n" "$HOST") \
  -out server.pem
