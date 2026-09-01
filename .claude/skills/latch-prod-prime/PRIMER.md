# Plow Latch Prod Primer — {{TIMESTAMP}}

You are working against the production Plow Latch install on this Mac (`/Applications/Plow Latch.app`, bundle `co.plow.domo-desktop`, device `{{DEVICE_ID_SHORT}}…`). This primer is the layout + recipes for that surface area.

## 1 — Discovery snapshot

{{PROBES_TABLE}}

## 2 — Filesystem map

**App bundle** — `/Applications/Plow Latch.app`:

- Running processes match `pgrep -f "Plow Latch.app/Contents/MacOS"`.

**App support root** — `~/Library/Application Support/Plow-Latch/`:

- `app/settings.json` — `relayCredentialEnc` (**SECRET — never print**; the login session sealed with the OS keychain, which is where a signed-in Mac normally keeps it) or `relayCredential` (**SECRET — never print**; the plaintext floor, used where no keychain is available and in homes written before sealing). Exactly one is present while a stored session is readable; an unreadable seal is cleared and treated as signed out. Also `accountUid`, `mcpUrl`, `approvalMode` (e.g. `adversarial`), `agentPurpose` (free text), `provisionedChatUid`, `autoCheckUpdates`, `windowBounds.*`.
- `device/identity.json` — `deviceId`, `name`, `privateKeyBase64` (**SECRET — never print**).
- `device/audit.ndjson` — NDJSON records keyed by `event`: `intent_received` (`goal`, `capabilities[]`, `intentId`), `intent_decision` (`decision`, `source`, `intentId`), `approval_abandoned`, `exec_start` (`argv`), `exec_end` (`exit_code`). Rolls over by rename at 10MB into `device/audit.1.ndjson` (one previous generation kept) — read that one FIRST, then the current, for the whole history.
- `device/approvals/*.json` — approvals **in flight** only: a record is written before the owner is asked and removed once its decision is in the audit log, so an empty directory is the normal state. Fields: `intentId`, `agentId`, `agentName`, `capabilities[]`, `status` (`pending`, or settled with `decision`/`source`/`decidedAt` and `recorded: false` for the instant before the audit append). Anything here after a clean start is a bug, not history — the audit log is the history.
- `device/browser/` — `fingerprint-pin.json` (the one fingerprint this install presents), `profile` (the owner's seed profile), `profiles/<session>` (per-session clones, merged back and removed on close). No screenshots are kept on disk.
- `device/scratch` — per-run sandbox scratch; each run's directory is removed when it ends.
- `electron/` — Electron app state.
- `plow-wire.log` — wire-protocol log (top-level in the app-support root).

**Client MCP configs** — `~/.latch/*.json`: each named entry under `mcpServers` has `{type,url,headers.Authorization}` (**Authorization value is SECRET — never print**; the URL path embeds the deviceId).

**Relay** — `https://api.plow.co/v1/relay/devices/<deviceId>/mcp`. An unauthenticated request without both Accept types returns 406; with no/bad token expect 401/403 — any of these proves reachability.

## 3 — Workflow recipes

### R1. What did an agent just do?

The device audit log is the ground truth for executed intents:

```bash
AS="$HOME/Library/Application Support/Plow-Latch"
# Both generations, oldest first — the log rolls over by rename at 10MB.
audit() { cat "$AS/device/audit.1.ndjson" "$AS/device/audit.ndjson" 2>/dev/null; }
# Last decisions: who asked, what was decided, and how
audit | tail -20 | jq -c 'select(.event=="intent_decision") | {decision, source, intentId}'
# What actually ran (argv) and how it ended
audit | tail -20 | jq -c 'select(.event=="exec_start") | {intentId, argv}'
audit | tail -20 | jq -c 'select(.event=="exec_end") | {intentId, exit_code}'
```

Or use the repo recipe: `just audit` (already reads both generations).

### R2. Who is allowed what?

Decisions live in the audit log, paired to the request by `intentId`; the approvals directory holds only questions still waiting on the owner:

```bash
AS="$HOME/Library/Application Support/Plow-Latch"
# What each agent asked for and what was decided
cat "$AS/device/audit.1.ndjson" "$AS/device/audit.ndjson" 2>/dev/null \
  | jq -c 'select(.event=="intent_received") | {intentId, agent, capabilities}'
# Questions the owner has not answered yet (normally none)
ls "$AS/device/approvals"/*.json 2>/dev/null | xargs -I{} jq -c '{agentId, capabilities, status, createdAt}' {}
# Standing always-allow rules
jq -c '.[]' "$AS/device/rules.json" 2>/dev/null
```

### R3. Which agent binds this Mac?

- `app/settings.json` → `agentPurpose` (the owner's free-text mandate) and `approvalMode` (`adversarial` etc.):

  ```bash
  jq -r '{agentPurpose, approvalMode}' "$HOME/Library/Application Support/Plow-Latch/app/settings.json"
  ```

- To confirm a container/agent is bound to *this* device, compare its `DOMO_DEVICE_UID` against `device/identity.json`'s `deviceId` (print only the first 8 chars of each):

  ```bash
  jq -r '.deviceId[0:8]' "$HOME/Library/Application Support/Plow-Latch/device/identity.json"
  ```

### R4. Secret handling — read these files keys-only

`settings.json`, `identity.json`, and `~/.latch/*.json` all embed credentials. **Never `cat` them whole.** Project only non-secret keys:

```bash
# settings.json — presence/length only for the credential
jq -r '{approvalMode, mcpHost: (.mcpUrl|sub("^https?://";"")|split("/")[0]), signedIn: (((.relayCredentialEnc // "") + (.relayCredential // "")) | length > 0), relayCredLen: (((.relayCredentialEnc // "") | length) + ((.relayCredential // "") | length)), accountUidLast3: (.accountUid|tostring|.[-3:])}' "$HOME/Library/Application Support/Plow-Latch/app/settings.json"
# identity.json — deviceId first 8 chars; key length only
jq -r '{deviceId8: (.deviceId[0:8]), name, keyLen: (.privateKeyBase64|length)}' "$HOME/Library/Application Support/Plow-Latch/device/identity.json"
# client configs — host only, never headers
jq -r '.mcpServers | to_entries[] | [.key, (.value.url | sub("^https?://";"") | split("/")[0])] | @tsv' ~/.latch/*.json
```

Conventions: `relayCredentialEnc` / `relayCredential` / `privateKeyBase64` / `Authorization` — presence/length only, never the value. `deviceId` — first 8 chars. `accountUid` — last 3 chars.

## 4 — Boundary

`/latch-prod-prime` itself is read-only discovery: it probes local surfaces, makes one unauthenticated relay reachability check, and writes one owner-only primer to `$TMPDIR`. It performs **no mutations** — no approvals, no execs, no config changes, no authenticated relay calls. The recipes above are likewise read-only.
