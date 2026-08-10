# Connecting by URL (networked broker)

How to run Domo over the network. The design principle: **nobody hand-copies a
key, pin, or token.** Each party gets one **connection string** (from the broker)
and pastes it once — or, for a Mac, approves a short **pairing code**.

Design detail lives in `docs/network-security-runbook.md`; this is the operator's
guide. Build first (binaries land in `.build/debug/`):

```bash
swift build
```

## The three connection strings

- **Device connection string** — `{ broker URL, cert pin }`. Public; safe to
  show or QR. Pasted into the Domo app (or opened as a `domo://` link).
- **Agent connection string** — `{ broker URL, pin, token }`. The token is a
  secret — deliver it in-app, not over a logged channel.
- Both are the compact `domo1.…` form (or a `domo://connect?c=…` deep link).

---

## Track A — the easy path (hosted `wss`, auto everything)

### 1. Run the broker — it provisions its own TLS on first run

```bash
domo-broker --home /var/lib/domo \
  --agent-listen wss://0.0.0.0:8443/ --device-listen wss://0.0.0.0:8444/ \
  --public-host broker.example --require-enrollment
```

No cert flags needed: the broker generates a self-signed cert under
`<home>/tls`, computes the pin, and prints the **device connection string**:

```
Device connection string (paste into the Domo app):
  domo1.eyJ…
Issue an agent:  domo-broker issue-agent --home /var/lib/domo --name <name>
```

(You can reprint it anytime with `domo-broker connect-string --home /var/lib/domo`.)

Prefer a config file? `domo-broker --config broker.json` where the JSON has keys
`home`, `agent-listen`, `device-listen`, `public-host`, `require-enrollment: true`.

### 2. Connect the Mac — paste, then approve a code

Open the Domo app. On first run it asks for a connection string:

- **Paste** the device connection string and click **Connect**, or
- Click **Pair this Mac…** — the app shows a short code (and QR). Approve it on
  the broker:

  ```bash
  domo-broker pending --home /var/lib/domo         # shows the code + device
  domo-broker approve-pairing --home /var/lib/domo --code <code>
  ```

  Then click **Connect**. (Pairing means you never copy a public key.)

The app's menu-bar icon shows the link state and has a **Pause (disconnect)**
kill switch and per-agent **Revoke**.

### 3. Give an agent access — one string

```bash
domo-broker issue-agent --home /var/lib/domo --name "Claude"
```

prints a ready line to paste once:

```bash
claude mcp add domo -e DOMO_CONNECTION='domo1.…' -- /path/to/domo-mcp
```

`DOMO_CONNECTION` carries the URL, pin, and token together. (You can also drop it
in `~/.domo/agent.json` as `{"connection":"domo1.…"}` and run the shim bare.)

Mac-initiated instead? In the app's **Goals** tab, pick a goal and **Start
Agent** — it opens a Terminal with the agent pre-configured, and copies the
equivalent `claude mcp add …` one-liner to your clipboard.

---

## Track B — plain `ws://` (dev / trusted LAN, no TLS)

Skip TLS for local testing. The broker prints no pin (there's nothing to pin):

```bash
domo-broker --home /tmp/domo --agent-listen ws://0.0.0.0:8443/ --device-listen ws://0.0.0.0:8444/
domo-broker --home /tmp/domo create-agent --name Claude      # {token,…}
```

Device (headless): `domo-device --home /tmp/domo/dev --broker ws://HOST:8444/ --policy policy.json`.
Agent: `-e DOMO_CONNECTION=ws://HOST:8443/` won't carry a token, so use
`-e DOMO_AGENT_TOKEN=… -e DOMO_AGENT_SOCKET=ws://HOST:8443/`.

`just app` still runs the app against a local Unix-socket broker — unchanged.

---

## Manual escape hatches (still supported)

- Bring your own cert: `--tls-p12 <file> --tls-password <pw>` instead of auto-TLS.
- Enroll by key: `domo-device identity --home <dir>` → copy `publicKey` →
  `domo-broker enroll-device --pubkey <key>`.
- Individual agent env vars: `DOMO_AGENT_TOKEN`, `DOMO_AGENT_SOCKET`,
  `DOMO_BROKER_PIN`.
- Revoke: `domo-broker revoke-agent --agent-id <id>` (or the app's menu bar).

## Gotchas

- Agent URL and device URL are **different ports** (8443 agent, 8444 device).
- On a `wss://` URL a missing pin **fails closed** — no silent CA fallback.
- The agent connection string holds a secret token; treat it like a password.
