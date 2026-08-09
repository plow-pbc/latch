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

## Phase 1 — TLS/WebSocket transport

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

## Phase 2 — Certificate pinning (self-signed, no public CA)

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

## Phase 3 — Identity & enrollment

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

## Phase 4 — End-to-end encryption (broker becomes a blind relay)

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

## Phase 5 — Revocation

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

## Phase 6 — Hosting the broker

**Goal:** run the broker as a real service.

**Steps**
1. Deploy the broker (container/VM) terminating WSS (Phase 1/2). Decide: TLS in
   the broker vs. at a reverse proxy (if proxy, the pin covers the proxy leaf).
2. Persistence for `agents.json`/`devices.json` beyond a single process; the
   reload-on-miss logic in `BrokerStore` already tolerates external writes but
   revisit for concurrency at scale.
3. Mac reconnect + wake: persistent outbound connection with backoff; later, a
   push channel to wake a sleeping Mac before routing.

**Acceptance**
- A Mac behind NAT connects out to the hosted broker; an agent elsewhere drives
  it end-to-end with approvals. Document the exact deploy in this file.

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

- [ ] Local Unix-socket E2E suite still green and still the default test path.
- [ ] Pinning tested against a *wrong* cert (reject path), not only the happy path.
- [ ] Challenge/auth rejection tested (Phase 3).
- [ ] Broker-tamper and broker-can't-read tests pass (Phase 4).
- [ ] Revocation-mid-session test passes (Phase 5).
- [ ] `InsecureLocalTrust` is used ONLY by the local transport; grep confirms it
      is never constructed on a network path.
- [ ] No business logic (`DomoDeviceCore`/`DomoBrokerCore` above `LineRPC`)
      changed to accommodate a transport.
- [ ] Run `/security-review` on the diff.

## Explicitly out of scope / do-not-do

- Don't trust the public CA store for the app/agent (pin instead).
- Don't add a listening port on the Mac (it always dials out).
- Don't let the broker hold agent private keys once Phase 3 lands (v1 does this
  as a documented local-only shortcut).
- Don't gate feature development on any of the above.
