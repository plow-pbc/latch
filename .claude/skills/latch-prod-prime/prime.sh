#!/usr/bin/env bash
# /latch-prod-prime — probe local prod Plow Latch surfaces and emit a primer.
# See SKILL.md (next to this file) for usage and the read-only boundary.
# No -e: run_probe treats a probe's non-zero return as data, not a fatal error.

set -uo pipefail

# --- Config -------------------------------------------------------------------
# The LATCH_PRIME_* env overrides exist for hermetic smoke runs;
# normal runs use the real prod paths.
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_SUPPORT="${LATCH_PRIME_APP_SUPPORT:-$HOME/Library/Application Support/Plow-Latch}"
LATCH_APP="${LATCH_PRIME_LATCH_APP:-/Applications/Plow Latch.app}"
CLIENT_CONFIG_DIR="${LATCH_PRIME_CLIENT_CONFIG_DIR:-$HOME/.latch}"
PRIMER_TEMPLATE="$SKILL_DIR/PRIMER.md"
# Unique, owner-only output path (mktemp creates it 0600) — a fixed /tmp name
# could be pre-created as a symlink by another local account and redirect the
# write. The actual path is printed in the digest.
# BSD mktemp only randomizes when the X's are the trailing chars (no suffix).
PRIMER_OUT=$(mktemp "${TMPDIR:-/tmp}/latch-prod-prime.XXXXXX")

# Parse flags
for arg in "$@"; do
  case "$arg" in
    -h|--help) echo "Usage: prime.sh"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

DEVICE_ID_SHORT="(unknown)"

# --- Probe registry -----------------------------------------------------------
# Each probe function:
#   - Sets PROBE_EVIDENCE (string) and returns 0 (pass) / nonzero (fail)
#   - Output collected in PROBE_ROWS as tab-delimited:  [STATUS]\tLABEL\tEVIDENCE
PROBE_ROWS=()
REQUIRED_FAIL=0
PROBE_EVIDENCE=""

run_probe() {
  # $1 = required|optional, $2 = label, $3 = function name
  local required="$1" label="$2" fn="$3" status
  PROBE_EVIDENCE=""
  if "$fn"; then
    status="OK"
  else
    case "$required" in
      required) status="FAIL"; REQUIRED_FAIL=1 ;;
      optional) status="WARN" ;;
    esac
  fi
  PROBE_ROWS+=("$(printf '[%s]\t%s\t%s' "$status" "$label" "$PROBE_EVIDENCE")")
}

# --- Probes ---------------------------------------------------------------------
# SECRETS: never print relayCredential, privateKeyBase64, or Authorization
# values — presence/length only. deviceId first 8 chars; accountUid last 3.

probe_app_bundle() {
  [[ -d "$LATCH_APP" ]] || { PROBE_EVIDENCE="$LATCH_APP not installed"; return 1; }
  local plist="$LATCH_APP/Contents/Info.plist"
  local version pid
  version="$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$plist" 2>/dev/null || echo "?")"
  pid="$(pgrep -f "$LATCH_APP/Contents/MacOS" | head -1)"
  if [[ -z "$pid" ]]; then
    PROBE_EVIDENCE="v$version installed but not running"
    return 1
  fi
  PROBE_EVIDENCE="v$version (PID $pid)"
  return 0
}

probe_settings() {
  local f="$APP_SUPPORT/app/settings.json"
  [[ -f "$f" ]] || { PROBE_EVIDENCE="missing — open Plow Latch.app to activate"; return 1; }
  command -v jq >/dev/null 2>&1 || { PROBE_EVIDENCE="jq missing — cannot verify"; return 1; }
  local mode cred_len uid3
  if ! mode=$(jq -r '.approvalMode // "adversarial"' "$f" 2>/dev/null); then
    PROBE_EVIDENCE="settings.json unreadable (bad JSON)"
    return 1
  fi
  cred_len=$(jq -r '.relayCredential // "" | length' "$f")
  uid3=$(jq -r '.accountUid // "" | tostring | .[-3:]' "$f")
  if (( cred_len == 0 )); then
    PROBE_EVIDENCE="relayCredential empty — device not activated"
    return 1
  fi
  PROBE_EVIDENCE="approvalMode=$mode · relayCredential present ($cred_len chars) · account …$uid3"
  return 0
}

probe_identity() {
  local f="$APP_SUPPORT/device/identity.json"
  [[ -f "$f" ]] || { PROBE_EVIDENCE="identity.json missing"; return 1; }
  command -v jq >/dev/null 2>&1 || { PROBE_EVIDENCE="jq missing — cannot verify"; return 1; }
  local id name key_len
  id=$(jq -r '.deviceId // ""' "$f" 2>/dev/null)
  name=$(jq -r '.name // "?"' "$f" 2>/dev/null)
  key_len=$(jq -r '.privateKeyBase64 // "" | length' "$f" 2>/dev/null)
  if [[ -z "$id" ]] || (( key_len == 0 )); then
    PROBE_EVIDENCE="deviceId or private key missing"
    return 1
  fi
  DEVICE_ID_SHORT="${id:0:8}"
  PROBE_EVIDENCE="device ${DEVICE_ID_SHORT}… (\"$name\") · key present"
  return 0
}

probe_audit_log() {
  local f="$APP_SUPPORT/device/audit.ndjson"
  [[ -f "$f" ]] || { PROBE_EVIDENCE="audit.ndjson missing"; return 1; }
  local total age last_type
  total=$(wc -l <"$f" | tr -d ' ')
  age=$(( $(date +%s) - $(stat -f %m "$f") ))
  if command -v jq >/dev/null 2>&1; then
    last_type=$(tail -1 "$f" | jq -r '.event // "?"' 2>/dev/null || echo "?")
  else
    last_type="?"
  fi
  PROBE_EVIDENCE="$total events · latest ${age}s ago ($last_type)"
  return 0
}

probe_approvals() {
  local dir="$APP_SUPPORT/device/approvals"
  [[ -d "$dir" ]] || { PROBE_EVIDENCE="approvals dir missing"; return 1; }
  local count latest
  count=$(find "$dir" -maxdepth 1 -name '*.json' | wc -l | tr -d ' ')
  if (( count == 0 )); then
    PROBE_EVIDENCE="no approval records yet"
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    PROBE_EVIDENCE="$count records (jq missing — latest not read)"
    return 0
  fi
  latest=$(ls -t "$dir"/*.json 2>/dev/null | head -1)
  # decision/source only — Latch-internal enums. agentName is relay-controlled
  # display text; substituting it into the primer would hand a remote agent a
  # line of prose in the next Claude session's context.
  PROBE_EVIDENCE="$count records · latest: $(jq -r '"\(.decision // "?") via \(.source // "?")"' "$latest" 2>/dev/null || echo "?")"
  return 0
}

probe_relay() {
  command -v curl >/dev/null 2>&1 || { PROBE_EVIDENCE="curl missing"; return 1; }
  command -v jq >/dev/null 2>&1 || { PROBE_EVIDENCE="jq missing — mcpUrl not read"; return 1; }
  local f="$APP_SUPPORT/app/settings.json" url code
  url=$(jq -r '.mcpUrl // empty' "$f" 2>/dev/null)
  [[ -n "$url" ]] || { PROBE_EVIDENCE="no mcpUrl in settings.json"; return 1; }
  # Deliberately unauthenticated POST (MCP endpoints reject GET with 405):
  # 401/403/406 all prove the relay is up and correctly demanding auth.
  # Never send (or print) the relayCredential.
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST \
    -H 'Accept: application/json, text/event-stream' "$url")
  case "$code" in
    401|403|406) PROBE_EVIDENCE="HTTP $code unauthenticated (reachable)"; return 0 ;;
    000)         PROBE_EVIDENCE="unreachable (timeout/DNS)"; return 1 ;;
    *)           PROBE_EVIDENCE="unexpected HTTP $code"; return 1 ;;
  esac
}

probe_client_configs() {
  command -v jq >/dev/null 2>&1 || { PROBE_EVIDENCE="jq missing"; return 1; }
  local names=() f host
  for f in "$CLIENT_CONFIG_DIR"/*.json; do
    [[ -f "$f" ]] || continue
    # Host only — the URL path embeds the deviceId; headers hold Authorization.
    host=$(jq -r '.mcpServers.plow.url // "" | sub("^https?://";"") | split("/")[0]' "$f" 2>/dev/null)
    names+=("$(basename "$f" .json)→${host:-?}")
  done
  if (( ${#names[@]} == 0 )); then
    PROBE_EVIDENCE="no client configs in $CLIENT_CONFIG_DIR"
    return 1
  fi
  PROBE_EVIDENCE="${#names[@]} configs: ${names[*]}"
  return 0
}

probe_browser_runtime() {
  local dir="$APP_SUPPORT/device/browser"
  [[ -d "$dir" ]] || { PROBE_EVIDENCE="device/browser missing"; return 1; }
  local vw_pid vw shots
  vw_pid=$(pgrep -f "browser-runtime/vault-server" | head -1)
  if [[ -n "$vw_pid" ]]; then vw="vaultwarden PID $vw_pid"; else vw="vaultwarden not running"; fi
  shots=$(find "$dir/screenshots" -type f 2>/dev/null | wc -l | tr -d ' ')
  PROBE_EVIDENCE="present · $vw · $shots screenshots"
  return 0
}

probe_wire_log() {
  local f="$APP_SUPPORT/plow-wire.log"
  [[ -f "$f" ]] || { PROBE_EVIDENCE="plow-wire.log missing"; return 1; }
  local age size
  age=$(( $(date +%s) - $(stat -f %m "$f") ))
  size=$(stat -f %z "$f")
  PROBE_EVIDENCE="${age}s old · ${size}b"
  return 0
}

# --- Main ---------------------------------------------------------------------
main() {
  run_probe required "Latch.app"        probe_app_bundle
  run_probe required "App settings"     probe_settings
  run_probe required "Device identity"  probe_identity
  run_probe required "Audit log"        probe_audit_log
  run_probe optional "Approvals"        probe_approvals
  run_probe optional "Relay"            probe_relay
  run_probe optional "Client configs"   probe_client_configs
  run_probe optional "Browser runtime"  probe_browser_runtime
  run_probe optional "Wire log"         probe_wire_log
}

# --- Output formatters ----------------------------------------------------------
emit_digest() {
  echo "latch-prod-prime — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  printf '%s\n' "${PROBE_ROWS[@]+"${PROBE_ROWS[@]}"}" | column -t -s $'\t'
  echo
  if [[ -s "$PRIMER_OUT" ]]; then
    echo "Primer written to $PRIMER_OUT (filesystem map + recipes inside)."
  else
    echo "Primer NOT written — see warnings above." >&2
  fi
}

emit_primer() {
  if [[ ! -f "$PRIMER_TEMPLATE" ]]; then
    echo "WARN: $PRIMER_TEMPLATE missing — primer not written" >&2
    return 1
  fi

  local timestamp probes_table
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  probes_table=$(printf '%s\n' "${PROBE_ROWS[@]+"${PROBE_ROWS[@]}"}" | column -t -s $'\t')

  # PRIMER_OUT was created 0600 by mktemp at startup; the `>` below truncates it
  # in place, preserving that owner-only mode.
  # awk substitution — sed chokes on multi-line probes_table.
  # Pass multi-line PROBES_TABLE via env (BSD awk rejects newlines in -v values).
  if ! PRIME_TS="$timestamp" \
       PRIME_TABLE="$probes_table" \
       PRIME_DEVICE="$DEVICE_ID_SHORT" \
       awk '
         {
           gsub(/\{\{TIMESTAMP\}\}/,       ENVIRON["PRIME_TS"])
           gsub(/\{\{PROBES_TABLE\}\}/,    ENVIRON["PRIME_TABLE"])
           gsub(/\{\{DEVICE_ID_SHORT\}\}/, ENVIRON["PRIME_DEVICE"])
           print
         }
       ' "$PRIMER_TEMPLATE" > "$PRIMER_OUT"; then
    echo "WARN: failed to render primer to $PRIMER_OUT" >&2
    return 1
  fi
  [[ -s "$PRIMER_OUT" ]] || { echo "WARN: primer rendered empty" >&2; return 1; }
  return 0
}

main
emit_primer; PRIMER_OK=$?
emit_digest

if (( REQUIRED_FAIL )); then exit 1; fi
if (( PRIMER_OK != 0 )); then exit 1; fi
exit 0
