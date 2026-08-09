# Network & Security Runbook

**What this is:** the ordered, concrete plan for taking Domo from the v1 local
loop (Unix sockets, no encryption) to a networked, secured deployment. It is
written to be *executed* — one phase at a time — either by you or by handing a
single phase to Claude Code (`claude -p "Do Phase 2 of docs/network-security-runbook.md"`).

**Why it's a separate file:** none of this is needed for feature development.
Features live above the transport and are built/tested on the local Unix-socket
loop. Do these phases only when remote access is actually on the roadmap.

## How to use it

- **Do one phase per change.** Each phase ends with `swift test` green **and** a
  new test that proves the phase. Don't start a phase until the previous one's
  acceptance test passes.
- **The Unix-socket transport stays the default test transport, forever.** The
  E2E suite must keep running over `UnixSocketDialer`/`SocketServer` — it's fast,
  deterministic, and needs no certs or hosting. Networked transports get their
  own focused tests; they do not replace the local ones.
- **Nothing above `LineRPC` should change.** Intents, MCP tools, the policy
  engine, the sandbox, and the audit log are transport-agnostic. If a phase
  makes you edit `DomoDeviceCore`/`DomoBrokerCore` business logic, stop and
  reconsider — you're probably leaking transport concerns upward.

## Invariants to preserve (check every phase)

- Intents remain Ed25519-signed with nonce + expiry; the device still verifies
  the signature against the agent key pinned at access-grant time.
- Approval authority never leaves the device owner. New transports change *who
  can reach* the device, never *who approves*.
- The broker never gains OS access and (from Phase 4 on) cannot read agent↔device
  payloads.
- `make test` / `swift test` stays green on the local loop the whole way.

---

## Phase 0 — Transport seam ✅ (done)

The connection layer is already abstracted so later phases are drop-ins.

- `Sources/DomoTransport/Transport.swift` — `Connection`, `ConnectionListener`,
  `ConnectionDialer`, `UnixSocketDialer`.
- `Sources/DomoTransport/TransportSecurity.swift` — `SPKIPin`,
  `PeerTrustEvaluator`, `InsecureLocalTrust`, `SPKIPinningEvaluator` (skeleton).
- `SocketConnection`/`SocketServer` conform to the protocols; `LineRPC` and the
  broker speak `Connection`, not `SocketConnection`.

Nothing above `LineRPC` knows what the transport is. That's the property every
later phase relies on.

---

## Phase 1 — TLS/WebSocket transport ✅ (done)

Implemented: `Sources/DomoTransport/WebSocketConnection.swift`
(`WebSocketConnection`/`WebSocketDialer`/`WebSocketListener` over
Network.framework, one WS message per line). `Broker` takes injected
`ConnectionListener`s; `DeviceAgent.connect(dialer:reconnect:)` dials any
transport with exponential-backoff reconnect. CLI: broker
`--agent-listen`/`--device-listen ws://…`, device `--broker ws://…`. Proven by
`Tests/DomoNetworkTests` (full scenario over WebSocket, bad-token reject,
broker-bounce reconnect). Unix suite unchanged and still default.

**Goal:** a `Connection`/`ConnectionListener`/`ConnectionDialer` implementation
over the network, so the Mac dials out to a broker URL and the agent connects to
the same URL — same routing as today.

**Steps**
1. Add `Sources/DomoTransport/WebSocketConnection.swift`:
   - `WebSocketConnection: Connection` wrapping `URLSessionWebSocketTask` (or
     `Network.framework` `NWConnection` with the `.ws` option). Map
     `send`/`receive` to `sendLine`/`onLine`; keep the newline framing contract
     (or switch to WS message framing internally — the line contract is what
     `LineRPC` needs, so preserve "one message in, one message out").
   - `WebSocketDialer: ConnectionDialer` carrying the broker `URL` and a
     `PeerTrustEvaluator` (used in Phase 2).
   - `WebSocketListener: ConnectionListener` for the broker side (or terminate
     TLS/WS at a reverse proxy and keep the broker on a local socket behind it —
     decide here and note it).
2. The Mac keeps dialing **outbound** and holds the connection open. Add
   reconnect-with-backoff (the socket path never had to reconnect; the network
   will drop).
3. Thread the dialer into `DeviceAgent.connect` via `ConnectionDialer` instead of
   a hardcoded path (today it uses `SocketClient.connect`). Broker gains a
   `--listen ws://…`/URL option alongside the existing `--device-socket`.

**Acceptance**
- New `Tests/DomoNetworkTests` that boots the broker with the WS listener and
  runs the *same* scenario as one E2E test (enroll → access → run_command) over
  `WebSocketDialer` against `127.0.0.1`. Reuse the `TestStack` scenario body.
- Local Unix-socket E2E suite still green and still the default.

**Notes**
- Reconnect must re-run registration/auth (Phase 3), not assume server state.
- Keep messages one-per-frame; don't reintroduce partial-read reassembly bugs.

---

## Phase 2 — Certificate pinning (self-signed, no public CA) ✅ (done)

Implemented: `SPKIHash.base64(derCertificate:)` extracts the SPKI via
Security.framework (`SecCertificateCopyKey` → `SecKeyCopyExternalRepresentation`
→ fixed ASN.1 SPKI header by key type → SHA-256 → base64), cross-checked against
the canonical OpenSSL pin in tests. `SPKIPinningEvaluator` now defaults to the
real extractor and is wired into the client TLS `sec_protocol_options_set_verify_block`
(WebSocketStack.clientParameters) INSTEAD of the system trust store; the server
presents a `SecIdentity`. Proven by `Tests/DomoNetworkTests/PinningTests`:
openssl cross-check, evaluator accept/reject/fail-closed, and a live `wss://`
handshake that connects to the pinned cert and **refuses** a different one.

**Goal:** the client trusts *one* pinned key, not the public CA system. This is
the intended production posture; a public CA (Let's Encrypt) is **not** required
and is weaker for a fleet you control.

**Steps**
1. Implement `SPKIPinningEvaluator.spkiHashOfLeaf`: parse the DER leaf with
   Security.framework (`SecCertificateCreateWithData` →
   `SecCertificateCopyKey` → `SecKeyCopyExternalRepresentation` → wrap in the
   DER SubjectPublicKeyInfo header for the key type → `SHA256` → base64). Pin the
   **SPKI**, not the whole cert, so leaf rotation doesn't require re-pinning.
2. Wire the evaluator into the Phase-1 transport's TLS handshake **instead of**
   the system trust store:
   - `URLSession`: `urlSession(_:didReceive:completionHandler:)` — evaluate the
     server trust yourself and `.useCredential`/`.cancelAuthenticationChallenge`.
   - `Network.framework`: `sec_protocol_options_set_verify_block` — call
     `evaluate(derChain:)` and complete with the result.
3. Dev certs: generate a self-signed cert (or a tiny local CA) once; commit the
   **pin value** (not the key) to a dev config. `mkcert` is fine for manual
   `curl`/browser poking, but it relies on the system trust store — your app
   must still exercise the *pinning* path, so test with a self-signed cert your
   code pins, not an mkcert-trusted one.

**Acceptance**
- Test: client connects successfully to a broker presenting the pinned cert.
- Test (the important one): client **refuses** a broker presenting a *different*
  self-signed cert (`evaluate` returns false → handshake fails). A pin never
  tested against a bad cert is not a working pin.

**Notes**
- On macOS, doing your own trust evaluation bypasses ATS's default rejection of
  self-signed certs — no ATS exception needed once pinning is in.
- Skip Let's Encrypt unless/until you run a *public* broker for third-party
  clients; even then keep pinning for the app + agent.

---

## Phase 3 — Identity & enrollment ✅ (done)

Implemented: `DeviceChallenge` (DomoProtocol) — domain-separated nonce signing.
Broker gains `requireEnrollment`; in that mode `acceptDevice` runs a
challenge/response BEFORE any RPC (fresh nonce → device signs → broker verifies
against the enrolled key), refusing unenrolled keys and bad signatures.
`DeviceAgent.connect(…, authenticate:)` answers the challenge on the raw
connection. Enrollment: `BrokerStore.enrollDevice`/`deviceById` + CLI
`domo-broker enroll-device --pubkey …` and `domo-device identity` (pairing
front-end). Key-storage seam `DeviceKeyStore` with `FileDeviceKeyStore` (default)
and `KeychainDeviceKeyStore`; Secure-Enclave note recorded in code (Enclave is
P-256-only, Domo signs Ed25519). Proven by `EnrollmentTests` (enrolled passes,
unenrolled refused, forged signature dropped before RPC, key-store round-trips).
The v1 Unix loop leaves `requireEnrollment` off, so its suite is unchanged.

**Goal:** device and agent identities bound to accounts, authenticated on every
connect. Replaces "trust because it's on my filesystem".

**Steps**
1. Move the device key into the Secure Enclave (`SecKeyCreateRandomKey` with
   `kSecAttrTokenIDSecureEnclave`); keep the file-backed key for headless
   `domo-device`/tests behind the existing `DeviceIdentity` seam.
2. Connect-time challenge/response: on connect the broker sends a nonce; each
   side signs it with its identity key; the broker verifies against the
   registered public key. Add this as the first exchange after the transport
   handshake (before `register`/MCP `initialize`).
3. Enrollment/pairing: device registers its public key against a provisioner
   account (code shown on the Mac, entered in the signed-in web session — see
   DESIGN.md §2). Agents are minted by the provisioner with their own keys.

**Acceptance**
- Test: a connection that fails the challenge is dropped before any RPC.
- Test: enrollment registers the device pubkey; a device presenting an
  unregistered key is refused.
- Existing bad-token test still passes (tokens remain the coarse gate until the
  challenge fully replaces them).

---

## Phase 4 — End-to-end encryption (broker becomes a blind relay) ✅ (channel done; live daemon wiring documented)

Implemented: `Sources/DomoTransport/E2EChannel.swift` — a mutually-authenticated,
end-to-end encrypted channel. Station-to-station / Noise-XX-equivalent handshake:
ephemeral **X25519** keys each **signed by the peer's Ed25519 identity key**
(pinned at grant/enrollment), shared secret via ECDH, split by HKDF-SHA256 into
two directional keys, application frames sealed with **ChaCha20-Poly1305**.
Built on CryptoKit rather than a libsodium/Noise binding — a deliberate deviation
that keeps Domo's zero-external-dependency posture using the same vetted
primitives; the security properties are identical.

Proven by `Tests/DomoNetworkTests/E2EChannelTests`: bidirectional round-trip;
**tampered frame rejected** (AEAD tag fails → device never sees plaintext);
**broker can't recover plaintext** from the transcript+frames (assert on wire
bytes); MITM ephemeral substitution rejected (no identity key to re-sign); wrong
expected-peer rejected; and a **real signed `Intent` carried through a blind
relay** — the relay can't read the request text, the device decrypts and the
signature still verifies, and a one-byte tamper is rejected before decode/verify/
execute. Intent signing is kept (channel = confidentiality/integrity; signature
= per-request authenticity the device checks independently).

**Remaining live-daemon wiring (documented):** in the running broker, intents are
still *built and signed on the broker* (the documented v1 shortcut — the broker
holds agent keys). Turning the channel on in the daemon means relocating intent
construction/signing to the agent endpoint (the `domo-mcp` shim holding the agent
key) and adding an opaque broker `relay` method that forwards `E2EChannel` frames
agent↔device without inspecting them. That step also discharges the Phase-3 note
"don't let the broker hold agent private keys." The crypto and its enforcement
are complete and tested; this is the integration that flips the switch.

**Goal:** the broker routes agent↔device without being able to read or forge
payloads. This is the crown jewel — more important than the TLS cert.

**Steps**
1. Add a Noise XX handshake (e.g. via a vetted libsodium binding) between agent
   and device, keyed by their identity keys, established *through* the broker
   relay after Phase-3 auth.
2. Encrypt the intent/response payloads inside the relay frames; the broker sees
   only routing metadata (device id, sizes, timing).
3. Keep intent signing — E2E gives confidentiality/integrity of the channel;
   signatures give per-request authenticity the device verifies independently.

**Acceptance**
- Test: a broker that tampers with a relayed frame causes the device to reject
  (MAC/signature failure), never to execute.
- Test: with a captured relay transcript, the broker cannot recover plaintext
  (assert on the wire bytes, not just behavior).

---

## Phase 5 — Revocation ✅ (done)

Implemented: broker-side `BrokerStore.revokeAgent`/`isRevoked` (persisted to
`revoked.json`, reload-on-miss) and `Broker.revokeAgent(_:)` — refuses routing
(`MCPSession` checks on every tool), notifies every device via a `revoke_agent`
RPC, and drops the agent's live sessions immediately. Device-side authoritative
revocation in `KnownAgents.revoke`/`isRevoked` (drops the key, remembers the
revocation across reloads, blocks silent re-pinning) with `DeviceAgent.revokeAgent`
and a `validate` check. CLI: `domo-broker revoke-agent --agent-id`. Proven by
`RevocationTests`: mid-session revoke drops the live session + broker refuses
reconnect routing; the **device rejects a revoked agent even when a stale broker
still routes** (device-authoritative); and `KnownAgents` revocation is
authoritative and persistent.

**Goal:** killing a grant takes effect immediately.

**Steps**
1. Provisioner-side revocation list; broker refuses to route for revoked agent
   ids and drops live sessions.
2. Device-side: `KnownAgents` gains removal; a revoked agent's signed intents are
   rejected even if a stale broker tries to route them.

**Acceptance**
- Test: revoke mid-session → in-flight and subsequent intents from that agent
  are refused at the device, and the broker stops routing.

---

## Phase 6 — Hosting the broker ✅ (done)

Implemented: broker `wss://` via `--tls-p12`/`--tls-password` (loaded by
`TLSIdentity`) combined with `--require-enrollment`; the Mac dials out with
`--pin`/`--authenticate` and reconnect-with-backoff (Phase 1); the agent shim
reaches a hosted broker via `DOMO_AGENT_SOCKET=wss://…` + `DOMO_BROKER_PIN`.
`scripts/gen-broker-cert.sh` mints the self-signed cert and prints the pin.
Proven by `HostedBrokerTests.testHostedConfigurationEndToEnd`: wss + pin +
enrollment + a remote agent driving `run_command` end to end.

### Exact deploy

**1. Mint the broker cert (self-signed + pin, no public CA):**
```
scripts/gen-broker-cert.sh /etc/domo/tls domo-broker <p12-password>
# prints the SPKI pin — give it to clients, never the key
```

**2. Run the broker** (container/VM with two published ports):
```
domo-broker --home /var/lib/domo \
  --agent-listen wss://0.0.0.0:8443/ --device-listen wss://0.0.0.0:8444/ \
  --tls-p12 /etc/domo/tls/broker-identity.p12 --tls-password <p12-password> \
  --require-enrollment
```
TLS terminates **in the broker** here. If you instead terminate at a reverse
proxy, pin the **proxy** leaf's SPKI and keep the broker on a local socket
behind it — the pin must cover whatever leaf the client actually sees.

**3. Enroll the Mac** (pairing; the web session is the production front-end):
```
# on the Mac:
domo-device identity --home ~/Library/Application\ Support/Domo   # -> {device_id, publicKey}
# on the broker (provisioner):
domo-broker --home /var/lib/domo enroll-device --pubkey <publicKey> --name "Alice's Mac"
```

**4. Mac dials out** (behind NAT — outbound only, no listening port on the Mac):
```
domo-device --home ~/Library/Application\ Support/Domo \
  --broker wss://broker.example:8444/ --pin <SPKI-pin> --authenticate
```

**5. Agent elsewhere** connects through the same broker:
```
claude mcp add domo -e DOMO_AGENT_TOKEN=<token> \
  -e DOMO_AGENT_SOCKET=wss://broker.example:8443/ -e DOMO_BROKER_PIN=<SPKI-pin> \
  -- /path/to/domo-mcp
```

### Persistence & reconnect
- `BrokerStore` persists `agents.json`/`devices.json`/`revoked.json` and uses
  reload-on-miss + merge-on-persist, so a separate provisioner process's writes
  are honored without a restart. **At scale** (multiple broker instances) replace
  the JSON files with a shared datastore — the store API is the seam; nothing
  above it changes.
- The Mac holds a persistent outbound connection and re-dials with exponential
  backoff (Phase 1). A push channel to wake a sleeping Mac before routing is the
  natural follow-on (out of scope here; needs APNs and is orthogonal to security).

---

## Phase 7 — iOS approval app

**Goal:** approve intents when away from the Mac — essential for cross-user use,
where Bob must approve requests to Bob's Mac without being at it.

**Steps**
1. iOS app authenticates to the provisioner, subscribes to pending intents for
   the user's devices, renders the same intent card (goal + capabilities), and
   returns a signed decision that the device honors.
2. The device treats a remote approval exactly like a local `UIPolicy` decision
   (same `Grant`, same audit event with the approval source recorded).

**Acceptance**
- Test (device-side): a signed remote decision drives the same
  `PolicyEngine`/`Grant` path as a local dialog; audit records `source` as the
  remote approver.

---

## Cross-cutting checklist (run before calling the network work "done")

- [x] Local Unix-socket E2E suite still green and still the default test path.
      (`swift test` = 63 tests green; the Unix E2E suite is unchanged and
      `requireEnrollment` defaults off on that path.)
- [x] Pinning tested against a *wrong* cert (reject path), not only the happy
      path. The accept path pins a self-signed cert the SYSTEM would reject, so it
      also proves pinning *replaces* system trust. (`PinningTests`)
- [x] Challenge/auth rejection tested (Phase 3). (`EnrollmentTests`:
      unenrolled refused, forged signature dropped before RPC.)
- [x] Broker-tamper and broker-can't-read tests pass (Phase 4).
      (`E2EChannelTests`)
- [x] Revocation-mid-session test passes (Phase 5). (`RevocationTests`)
- [x] `InsecureLocalTrust` is used ONLY by the local transport; grep confirms it
      is never *constructed* anywhere. Network dialers take `SPKIPinningEvaluator`
      or `nil` — and `nil` builds a plain-`ws` (no-TLS) stack, so a `wss://` URL
      can never silently fall back to system-CA trust.
- [x] No *transport* concern leaks above `LineRPC`. The changes in
      `DomoBrokerCore`/`DomoDeviceCore` are the **security features** each phase
      prescribes (enrollment challenge, revocation, reconnect), not knowledge of
      ws-vs-unix — the transport stays fully behind the `Connection` seam.
- [ ] Run `/security-review` on the diff. (Recommended once the tree is in a git
      repo; a manual self-audit of the crypto/auth paths was done — see the
      handoff notes.)

## Explicitly out of scope / do-not-do

- Don't trust the public CA store for the app/agent (pin instead).
- Don't add a listening port on the Mac (it always dials out).
- Don't let the broker hold agent private keys once Phase 3 lands (v1 does this
  as a documented local-only shortcut).
- Don't gate feature development on any of the above.
