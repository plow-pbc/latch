# Connecting by URL (networked broker)

How to run Domo over the network so the broker, device (Mac), and agent (Claude
Code) all connect by URL instead of local Unix sockets. This is the operational
companion to `docs/network-security-runbook.md`, which explains the design.

## Roles & addresses

Three roles, each addressed by a URL:

- **Broker** — listens on two URLs: an **agent** URL and a **device** URL
  (different ports; don't cross them).
- **Device** (the Mac being controlled) — dials the broker's **device** URL.
- **Agent** (Claude Code via the `domo-mcp` shim) — dials the broker's **agent** URL.

Build first; binaries land in `.build/debug/`:

```bash
swift build
```

> The AppKit app currently uses the local Unix socket. The URL/networked device
> side is the headless `domo-device` binary. (Wiring the GUI app to dial a URL is
> a follow-on — see the end of this doc.)

Credentials, at a glance:

- **Agent token** — the agent's credential. Minted with `domo-broker create-agent`.
  Independent of transport and enrollment.
- **Device enrollment** — authorizes a *device's* identity key (Track B only).
- **SPKI pin** — how clients trust the broker's self-signed cert (Track B only).

---

## Track A — Plain `ws://` (fastest; dev / trusted LAN)

Use `0.0.0.0` to accept connections from other machines, or `127.0.0.1` for
same-machine. Replace `BROKER_HOST` below with `127.0.0.1` or the broker's
IP/DNS.

**1. Broker** (terminal 1):

```bash
.build/debug/domo-broker --home /tmp/domo \
  --agent-listen  ws://0.0.0.0:8443/ \
  --device-listen ws://0.0.0.0:8444/
```

**2. Device** (terminal 2). Headless/CLI use needs an approval policy; for
interactive approval you'd use the GUI app instead:

```bash
echo '{"access":"allow","intent":"allow_once"}' > /tmp/domo/policy.json
.build/debug/domo-device --home /tmp/domo/dev \
  --broker ws://BROKER_HOST:8444/ \
  --name "My Mac" --policy /tmp/domo/policy.json
# prints:  domo-device ready id=<DEVICE_ID>
```

**3. Mint an agent token** (terminal 3):

```bash
.build/debug/domo-broker --home /tmp/domo create-agent --name "Claude"
# prints:  {"token":"<TOKEN>", "agent_id":"<AGENT_ID>", ...}
```

**4. Connect Claude Code** (the shim dials the agent URL):

```bash
claude mcp add domo \
  -e DOMO_AGENT_TOKEN=<TOKEN> \
  -e DOMO_AGENT_SOCKET=ws://BROKER_HOST:8443/ \
  -- /ABS/PATH/.build/debug/domo-mcp
```

Then, in Claude: `list_devices` → `request_device_access` (device `<DEVICE_ID>`)
→ `run_command`, etc.

---

## Track B — `wss://` + pinning + enrollment (hardened / hosting)

**1. Mint a self-signed broker cert and get its pin:**

```bash
just gen-cert /tmp/domo/tls          # or: scripts/gen-broker-cert.sh /tmp/domo/tls
# prints the SPKI pin — call it <PIN>; writes broker-identity.p12 (password: domo)
```

**2. Broker over `wss://`, enrollment required:**

```bash
.build/debug/domo-broker --home /tmp/domo \
  --agent-listen  wss://0.0.0.0:8443/ \
  --device-listen wss://0.0.0.0:8444/ \
  --tls-p12 /tmp/domo/tls/broker-identity.p12 --tls-password domo \
  --require-enrollment
# (or:  just broker-wss /tmp/domo/tls/broker-identity.p12 domo)
```

**3. Enroll the device** (pairing; a signed-in web session is the production
front-end):

```bash
# on the Mac:
.build/debug/domo-device identity --home /tmp/domo/dev     # -> {device_id, publicKey}
# on the broker:
.build/debug/domo-broker --home /tmp/domo enroll-device --pubkey <publicKey> --name "My Mac"
```

**4. Device dials out, pinning the broker + authenticating:**

```bash
.build/debug/domo-device --home /tmp/domo/dev \
  --broker wss://BROKER_HOST:8444/ \
  --pin <PIN> --authenticate \
  --name "My Mac" --policy /tmp/domo/policy.json
```

**5. Mint an agent token** (same as Track A — token issuance is independent of
TLS/enrollment):

```bash
.build/debug/domo-broker --home /tmp/domo create-agent --name "Claude"
# prints:  {"token":"<TOKEN>", "agent_id":"<AGENT_ID>", ...}
```

**6. Agent connects with the pin:**

```bash
claude mcp add domo \
  -e DOMO_AGENT_TOKEN=<TOKEN> \
  -e DOMO_AGENT_SOCKET=wss://BROKER_HOST:8443/ \
  -e DOMO_BROKER_PIN=<PIN> \
  -- /ABS/PATH/.build/debug/domo-mcp
```

**Revoke an agent anytime:**

```bash
.build/debug/domo-broker --home /tmp/domo revoke-agent --agent-id <AGENT_ID>
```

---

## Gotchas

- **Agent URL vs device URL are different ports** (8443 agent, 8444 device) —
  don't cross them.
- On a `wss://` URL, if you omit the pin the handshake **fails closed** — there
  is no silent fall-back to system-CA trust. That's intentional.
- The `--home` for the broker and the device can be the same directory locally,
  but across machines each host has its own home (the device's identity/audit
  live in the device's home; the broker's agent/device registries live in the
  broker's home).
- Give `domo-mcp` an **absolute** path to the binary in `claude mcp add`.

## Not yet wired: GUI approval over the network

The AppKit app connects to a local Unix-socket broker today. To approve intents
in the real UI over a networked broker, the app needs to dial a `ws(s)://` URL
(and, for Track B, pin + enroll) — the same `DeviceAgent.connect(dialer:…)` path
the headless runner already uses. This is a small follow-on, not yet done.
