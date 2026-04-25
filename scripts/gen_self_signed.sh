#!/usr/bin/env bash
# Generate a self-signed TLS certificate for ShotCatcher Chart UI Server.
# Usage: ./gen_self_signed.sh [output_dir]
#
# Creates:
#   <output_dir>/server.key  — private key
#   <output_dir>/server.crt  — self-signed certificate (365 days)

set -euo pipefail

OUT_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)/config}"
mkdir -p "$OUT_DIR"

KEY="$OUT_DIR/server.key"
CRT="$OUT_DIR/server.crt"

if [[ -f "$KEY" && -f "$CRT" ]]; then
    echo "Certificate already exists at $OUT_DIR/"
    echo "  Key:  $KEY"
    echo "  Cert: $CRT"
    echo "Delete them first to regenerate."
    exit 0
fi

echo "Generating self-signed certificate in $OUT_DIR/ ..."

openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$KEY" \
    -out "$CRT" \
    -days 365 \
    -subj "/CN=shotcatcher/O=ShotCatcher/C=US" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

chmod 600 "$KEY"
chmod 644 "$CRT"

echo "Done."
echo "  Key:  $KEY"
echo "  Cert: $CRT"
echo ""
echo "Add to config.py or env:"
echo "  CHART_UI_SSL_CERTFILE=$CRT"
echo "  CHART_UI_SSL_KEYFILE=$KEY"
