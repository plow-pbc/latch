---
name: latch-smoke
description: Prove an installed Latch actually works, by driving one real MCP call through the relay and reading the result out of audit.ndjson. Use after installing a build, after any change to the relay client, the MCP server or the exec path, or when someone asks whether a Mac is reachable. Works against the local install or any SSH-reachable one.
---

# Latch smoke — one real call, verified in the audit log

The unit test suite never opens a socket to a real relay
(`docs/TESTING-THE-APP.md` says so explicitly). This is the leg that does: an
MCP client → the Plow relay → the device WebSocket → `@domo/mcp-server` on the
Mac → the audit log.

**The audit log is the proof, not the client's reply.** A reply can come from a
cached deferred handle or a half-working path; an `exec_start`/`exec_end` pair
with your nonce in the argv cannot.

## Before you start: the credential

You need an MCP client registration for the target install — endpoint plus
bearer token. **This is not currently recorded anywhere an unattended run can
read**, which is Stop 3 in `docs/AUTONOMOUS-OPERATION.md`. Today it comes from
the app's Agents tab on the target Mac, which is a GUI step.

If you have one, it looks like the block `_mcpConfig` renders:

```json
{"mcpServers":{"plow":{"type":"http","url":"<mcpUrl>","headers":{"Authorization":"Bearer <token>"}}}}
```

Treat the token the way this repo treats every credential: never echo it, never
put it in a log line or a commit, reference it by its last 3 characters only.

## Send

A nonce makes the audit line unambiguous — a busy install has other traffic, and
`grep`ping for `echo` alone would match somebody else's run.

```bash
NONCE="latch-smoke-$(date -u +%Y%m%dT%H%M%SZ)"
TOKEN_FILE="${TOKEN_FILE:?a 0600 file holding the bearer token}"
MCP_URL="${MCP_URL:?the install's mcpUrl}"
python3 - "$NONCE" <<'PYCALL'
import json, os, sys, urllib.request

# The wire shape is NOT generic JSON-RPC. This server validates that the body's
# method and tool name AGREE with headers declaring them, and every request
# carries the per-request envelope in params._meta -- modern MCP is per-request,
# so there is no initialize handshake and no session to open first.
# packages/mcp-server/test/client.ts is the authority; keep this in step with it,
# and with PROTOCOL_REVISION in handler.ts.
REVISION = "2026-07-28"
nonce, name = sys.argv[1], "plow_run_command"
token = open(os.environ["TOKEN_FILE"]).read().strip()

body = json.dumps({
    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
    "params": {
        "name": name,
        "arguments": {
            "argv": ["/bin/echo", nonce],
            "goal": "smoke test: prove this Mac executes an approved command",
        },
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": REVISION,
            "io.modelcontextprotocol/clientInfo": {"name": "latch-smoke", "version": "1"},
            "io.modelcontextprotocol/clientCapabilities": {},
        },
    },
}).encode()

req = urllib.request.Request(os.environ["MCP_URL"], data=body, method="POST", headers={
    "Authorization": "Bearer " + token,
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": REVISION,
    "MCP-Method": "tools/call",
    "MCP-Name": name,
})
with urllib.request.urlopen(req, timeout=90) as r:
    payload = json.load(r)
# A JSON-RPC error or isError is a real failure. Neither absence is PROOF of
# success, though -- that is the audit log.
print("status", r.status, "| error:", payload.get("error"),
      "| isError:", payload.get("result", {}).get("isError"))
PYCALL
echo "NONCE=$NONCE"   # print it -- Verify runs in a FRESH shell
```

**This raises an approval dialog on the target Mac** unless a matching
always-allow rule exists. That is the product working, not a failure — but it
means a fully unattended smoke needs either a pre-seeded rule or
`HeadlessPolicy`, neither of which a shipped app exposes. Say so in the report
rather than waiting on a dialog nobody is watching.

## Verify — the actual proof

The instance home is `~/Library/Application Support/Plow-Latch` for a packaged
install, and `Plow-Latch-<branch>` for a from-source run
(`scripts/worktree-name.sh --branch`).

```bash
NONCE="<value printed by Send>"
HOME_DIR="${HOME_DIR:-$HOME/Library/Application Support/Plow-Latch}"
SCRIPT='NONCE="'"$NONCE"'"; LOG="'"$HOME_DIR"'/device/audit.ndjson";
for i in $(seq 1 24); do
  # exec_start ONLY. intent_received records capabilityDisplay, which for a
  # process.exec includes the argv — so it carries the nonce too, and it is
  # written BEFORE the decision. Matching the nonce alone reports success on a
  # call the owner denied, which is the exact false positive this gate exists
  # to prevent. Its intentId keys the exec_end that follows.
  LINE=$(grep "$NONCE" "$LOG" 2>/dev/null | grep -m1 "\"event\":\"exec_start\"") || true
  if [ -n "$LINE" ]; then
    echo "$LINE"
    ID=$(printf %s "$LINE" | python3 -c "import json,sys; print(json.load(sys.stdin).get(\"intentId\",\"\"))")
    [ -n "$ID" ] && grep "$ID" "$LOG" | grep -E "\"event\":\"exec_(end|error)\"" | head -1
    exit 0
  fi
  sleep 5
done
# Two different failures, and they send you to different places. The nonce
# reaching intent_received means the relay and the device both worked and the
# call is sitting at the approval dialog; the nonce being absent entirely means
# it never arrived — wrong install, wrong credential, or a dead socket.
ANY=$(grep "$NONCE" "$LOG" 2>/dev/null | tail -2) || true
if [ -n "$ANY" ]; then
  echo "$ANY"
  ID=$(printf %s "$ANY" | head -1 | python3 -c "import json,sys; print(json.load(sys.stdin).get(\"intentId\",\"\"))" 2>/dev/null)
  # intent_decision is what names a denial.
  [ -n "$ID" ] && grep "$ID" "$LOG" | grep "intent_decision" | head -1
  echo "TIMEOUT - reached this Mac, never executed: denied, or waiting on the dialog"
else
  echo "TIMEOUT - nothing carrying $NONCE: it never reached this install"
fi
exit 1'
bash -c "$SCRIPT"                                                   # local install
# ssh -o ConnectTimeout=8 -o BatchMode=yes <user>@<host> "$SCRIPT"   # remote (host map: tailscale-ssh skill)
```

Quote the `exec_start` and `exec_end` lines as the verification. An
`exec_start` with no `exec_end` means the run is still going or was reaped; an
`exec_error` names why it failed.

On timeout it distinguishes the two failures, because they send you to
different places: the nonce reaching `intent_received` means the relay and the
device both worked and the call is at the approval dialog (it quotes the
`intent_decision` line, which is what names a denial), while the nonce being
absent entirely means it never arrived — wrong install, wrong credential, or a
dead socket.

## Smoke-testing the gog provider specifically

Same shape, different argv — and it needs `gog` staged and
`gmail:access-token` in the device's scopes:

```
["gog", "gmail", "search", "newer_than:1d", "--json"]
```

Three things distinguish a working provider path from a broken one, all visible
in the audit log without touching Google:

| Line | Means |
|---|---|
| `exec_error` … `not installed` | no vendored binary — run `just fetch-gog` and repackage |
| `exec_error` … `could not reach Plow` / `returned 4xx` | the mint failed; check the device credential's scopes |
| `exec_start` then `exec_end exit_code=0` | the whole path works |

A `403` *inside* gog's own output is not a Latch failure — the token carries
four Google scopes and refuses everything else by design.

## Failure triage

- HTTP 401/403 from the relay → the credential is wrong or the device was
  re-paired. Scopes freeze at mint; a Mac paired before a scope grant needs to
  re-activate.
- Call returns, and the log carries the nonce but no `exec_start` → it arrived
  and was denied or is unanswered. Read the `intent_decision` line; this is the
  approval dialog, not a plumbing problem.
- Call returns, and *nothing* carries the nonce → you are reading a
  **different** install's log. Check the instance home (branch-suffixed homes
  are the usual cause).
- Approval dialog never answered → expected on an unattended run; see above.
