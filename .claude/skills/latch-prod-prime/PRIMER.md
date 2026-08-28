# Plow Latch Prod Primer — {{TIMESTAMP}}

You are working against the production Plow Latch install on this Mac (`/Applications/Plow Latch.app`, bundle `co.plow.domo-desktop`, device `{{DEVICE_ID_SHORT}}…`). This primer is the layout + recipes for that surface area.

## 1 — Discovery snapshot

{{PROBES_TABLE}}

## 2 — Filesystem map

**App bundle** — `/Applications/Plow Latch.app`:

- Running processes match `pgrep -f "Plow Latch.app/Contents/MacOS"`.
- A `vaultwarden` child runs from `Contents/Resources/browser-runtime/vault-server/`.

**App support root** — `~/Library/Application Support/Plow-Latch/`:

- `app/settings.json` — `relayCredential` (**SECRET — never print**), `accountUid`, `mcpUrl`, `approvalMode` (e.g. `adversarial`), `agentPurpose` (free text), `provisionedChatUid`, `autoCheckUpdates`, `windowBounds.*`.
- `device/identity.json` — `deviceId`, `name`, `privateKeyBase64` (**SECRET — never print**).
- `device/audit.ndjson` — NDJSON records keyed by `event`: `intent_decision` (`decision`, `source`, `intentId`), `exec_start` (`argv`), `exec_end` (`exit_code`).
- `device/approvals/*.json` — one per intent: `intentId`, `agentId`, `agentName`, `capabilities[]`, `status`, `decision`, `source`, `createdAt`, `decidedAt`.
- `device/browser/` — `profile`, `profiles`, `vault`, `screenshots`, `credential-audit.log`, `pyhome`.
- `device/scratch` — agent scratch space.
- `electron/` — Electron app state.
- `plow-wire.log` — wire-protocol log (top-level in the app-support root).

**Client MCP configs** — `~/.latch/*.json`: `mcpServers.plow.{type,url,headers.Authorization}` (**Authorization value is SECRET — never print**; the URL path embeds the deviceId).

**Relay** — `https://api.plow.co/v1/relay/devices/<deviceId>/mcp`. An unauthenticated request without both Accept types returns 406; with no/bad token expect 401/403 — any of these proves reachability.

## 3 — Workflow recipes

### R1. What did an agent just do?

The device audit log is the ground truth for executed intents:

```bash
AS="$HOME/Library/Application Support/Plow-Latch"
# Last decisions: who asked, what was decided, and how
tail -20 "$AS/device/audit.ndjson" | jq -c 'select(.event=="intent_decision") | {decision, source, intentId}'
# What actually ran (argv) and how it ended
tail -20 "$AS/device/audit.ndjson" | jq -c 'select(.event=="exec_start") | {intentId, argv}'
tail -20 "$AS/device/audit.ndjson" | jq -c 'select(.event=="exec_end") | {intentId, exit_code}'
```

Or use the repo recipe: `just audit`.

### R2. Who is allowed what?

Approval records pair each intent with the agent that asked and the decision:

```bash
AS="$HOME/Library/Application Support/Plow-Latch"
ls -t "$AS/device/approvals"/*.json | head -5 | xargs -I{} jq -c '{agentName, capabilities, decision, source, status, decidedAt}' {}
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
jq -r '{approvalMode, mcpUrl, relayCredLen: (.relayCredential|length), accountUidLast3: (.accountUid|tostring|.[-3:])}' "$HOME/Library/Application Support/Plow-Latch/app/settings.json"
# identity.json — deviceId first 8 chars; key length only
jq -r '{deviceId8: (.deviceId[0:8]), name, keyLen: (.privateKeyBase64|length)}' "$HOME/Library/Application Support/Plow-Latch/device/identity.json"
# client configs — host only, never headers
jq -r '.mcpServers.plow.url | sub("^https?://";"") | split("/")[0]' ~/.latch/*.json
```

Conventions: `relayCredential` / `privateKeyBase64` / `Authorization` — presence/length only, never the value. `deviceId` — first 8 chars. `accountUid` — last 3 chars.

## 4 — Boundary

`/latch-prod-prime` itself is read-only discovery: it probes local surfaces, makes one unauthenticated relay reachability check, and writes one owner-only primer to `$TMPDIR`. It performs **no mutations** — no approvals, no execs, no config changes, no authenticated relay calls. The recipes above are likewise read-only.
