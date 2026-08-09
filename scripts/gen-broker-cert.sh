#!/usr/bin/env bash
# Generate a self-signed broker certificate for wss:// (runbook Phase 6).
#
# The intended posture is self-signed + SPKI pinning — NOT a public CA. This
# prints the pin value to embed in the Mac (`domo-device --pin`) and agent
# (DOMO_BROKER_PIN) config, and writes a PKCS#12 the broker serves with
# (`domo-broker --tls-p12`).
#
# Usage: scripts/gen-broker-cert.sh <output-dir> [CN] [p12-password]
set -euo pipefail

OUT="${1:?usage: gen-broker-cert.sh <output-dir> [CN] [p12-password]}"
CN="${2:-domo-broker}"
PASS="${3:-domo}"

mkdir -p "$OUT"
KEY="$OUT/broker-key.pem"
CERT="$OUT/broker-cert.pem"
P12="$OUT/broker-identity.p12"

# EC P-256 self-signed cert (matches the SPKI pin extractor's default path).
openssl ecparam -name prime256v1 -genkey -noout -out "$KEY"
openssl req -x509 -new -key "$KEY" -out "$CERT" -days 3650 -subj "/CN=$CN" -sha256 >/dev/null 2>&1
openssl pkcs12 -export -inkey "$KEY" -in "$CERT" -out "$P12" -passout "pass:$PASS" -name domo >/dev/null 2>&1

PIN=$(openssl x509 -in "$CERT" -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary \
  | openssl base64)

cat <<EOF

Broker certificate written to: $OUT
  identity (broker serves this):  $P12   (password: $PASS)
  certificate:                    $CERT

SPKI pin (give this to clients — never the key):
  $PIN

Start the broker (wss + enrollment):
  domo-broker --home <dir> \\
    --agent-listen wss://0.0.0.0:8443/ --device-listen wss://0.0.0.0:8444/ \\
    --tls-p12 "$P12" --tls-password "$PASS" --require-enrollment

On the Mac (dials out, pins the broker, authenticates):
  domo-device identity --home <dir>        # copy the publicKey
  # ...enroll it on the broker: domo-broker enroll-device --pubkey <publicKey>
  domo-device --home <dir> --broker wss://broker.example:8444/ \\
    --pin "$PIN" --authenticate
EOF
