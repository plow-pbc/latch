# Multiple Latch Installations

**Status:** Approved for implementation on 2026-08-29

## Goal

Let one Plow account keep several Latch installations online at once and expose
each installation as its own named MCP server. The initial user is a single
account whose agents may use every active installation. A family-assistant
container can therefore connect to both `mbp` and `mba` without duplicating the
container or choosing one Mac for the whole agent.

## Product behavior

- Every Latch installation has a stable device ID and a hostname-derived
  display name.
- The first active installation is primary. When it is removed, the oldest
  remaining active installation becomes primary.
- Duplicate hostnames receive durable suffixes: `mbp`, `mbp (2)`, and so on.
  Existing records are never silently renumbered.
- Each active installation has its own MCP URL and connector name, such as
  `plow-mbp` and `plow-mba`.
- The existing account-UID MCP URL remains a compatibility alias to the
  primary installation. It never falls back when that primary is offline; the
  response names the unavailable primary.
- Every active `relay:call` credential for the account may call every active
  device owned by that account. Per-agent device grants are out of scope.

## Ownership boundaries

### Plow

Plow owns the durable device registry, account ownership, display-name
allocation, primary selection, device presence, connector discovery, and
routing to the selected device socket. It authorizes the caller against the
device's owning account before forwarding anything.

Plow continues to treat MCP request and response bodies as opaque. Device
selection comes from the URL or from resolving the compatibility alias, not
from parsing JSON-RPC.

### Latch

Latch owns its persistent device identity, supplies the DNS hostname during
registration, and authenticates a socket for that device. It remains the sole
owner of its tools, approvals, sandbox, execution, browser and vault state, and
local audit history.

### Agent runtime

The agent runtime remains one process or container. It receives one MCP server
entry per active device and chooses the named server for a call. No change to
the family-assistant container lifecycle is required.

## Identity and registration

Latch reuses `device.identity.deviceId`; a second installation identifier is
not introduced. After login, Latch registers this tuple with Plow:

```text
(account, device_id, dns_hostname, current_session_id)
```

The server creates or reactivates the device record. A socket handshake then
includes `device_id`, and Plow accepts it only when the authenticated session is
the record's current session and the record belongs to the authenticated
account. This prevents an account session from accidentally claiming a device
record owned by another account and prevents an old session from reconnecting
after a replacement login.

The stable ID is used in URLs and authorization. The hostname is presentation
metadata. Plow normalizes it to a non-empty, bounded display label and allocates
the first unused durable suffix across that account's device history. A copied
Latch home therefore collides on device identity rather than creating two
records; the newest authenticated socket for that exact device replaces the
older socket. A clean reinstall with a new identity creates a new record.

Signing out marks only that device inactive and revokes its current session.
Signing back in with the same local identity reactivates the record with its
original creation order and display name. Primary is derived as the oldest
active record, so the original installation becomes primary again when it is
reactivated.

## Endpoints and connector output

The canonical endpoint is:

```text
POST /v1/relay/devices/{device_id}/mcp
```

The existing form remains supported:

```text
POST /v1/relay/devices/{account_uid}/mcp
```

When the path segment is the authenticated caller's account UID, Plow resolves
the oldest active record and routes to it. Otherwise Plow resolves the segment
as a device ID and verifies that its account matches the caller's account.

Setup and roster APIs return active devices with stable IDs, display names,
primary state, connection state, and MCP URLs. Connector generation emits one
entry per active device. Connector keys use a deterministic slug of the display
name and add a stable short device-ID suffix only if slugging creates a
collision. All entries may share the same agent token.

The account-level URL remains what existing saved MCP configurations use. New
configuration output uses only device-specific URLs.

## Connection model and data flow

Relay sockets are keyed by `(account_uid, device_id)` rather than
`(account_uid, relay-device)`. Pending requests and concurrency limits are
likewise keyed by device ID.

For a device-specific call:

1. Resolve and authenticate the bearer credential.
2. Resolve the device record and require the same owning account.
3. Require the device record to be active.
4. Confirm that its current registered session is still active.
5. Send the opaque HTTP exchange to that device's fresh socket.
6. Correlate the reply by device ID and request ID.
7. Replay the device response unchanged.

The compatibility call performs the same flow after resolving the primary. It
does not select a different device based on online state.

## Failure behavior

- Unknown or cross-account device IDs return `403` without revealing whether a
  foreign device exists.
- A removed device returns `404` to its owner.
- No active primary returns `503` with a fixed "No active Latch installation"
  message.
- An offline selected device returns `503` and includes its safe display name.
- A stale or revoked device session closes only that device's socket and
  returns `503`.
- A duplicate socket for the same device replaces the prior socket. A socket
  for another device never evicts it.
- A request already delivered to a device follows the existing no-automatic-
  retry rule; disconnects wait for the bounded timeout to avoid duplicate work.
- Malformed hostnames fall back to a bounded `latch` label. Credentials and raw
  server error strings never enter logs or display names.

## Compatibility and migration

Existing installations have no server device record. On the first release
after upgrade, Latch registers its existing stable device identity before
opening the socket. The account alias means existing MCP clients need no
configuration change.

The server must accept the old socket handshake during a bounded rollout
window. It maps that connection to the account alias only when the account has
at most one active device. Once a second device exists, an old client is
rejected with an upgrade-required reason rather than ambiguously replacing or
impersonating another device. The compatibility lane is removed in a later
release after deployed Latches have upgraded.

## Testing and verification

### Plow

- Registry tests cover first registration, idempotent re-registration,
  hostname collisions, cross-account identity refusal, reactivation, and
  oldest-active primary promotion.
- WebSocket tests prove two devices under one account remain connected, same-
  device replacement is isolated, and revocation closes only the matching
  device/session.
- MCP endpoint tests prove device-specific routing, account-alias routing,
  offline-primary failure without fallback, cross-account non-disclosure,
  per-device in-flight isolation, and unchanged opaque bodies.
- Connector-output tests prove deterministic names and URLs for one and
  multiple devices.
- Migration tests cover an upgraded existing install and the bounded legacy
  handshake rule.

### Latch

- Registration client tests prove the existing device ID and hostname are
  sent, server-authored identity is parsed defensively, and no credential is
  exposed to renderer state or logs.
- Relay wire and lifecycle tests cover the device ID in authentication and
  verify that rejection remains credential-redacted.
- Onboarding tests prove registration completes before socket startup and a
  failed registration does not show the install as connected.
- Settings tests prove the server device metadata survives restart without
  creating another local identity.

### Integrated behavior

Run the repositories' canonical gates, then exercise two fake Latch sockets for
one account through the real Plow ASGI application. Both must remain present;
each device URL must reach only its socket; the account alias must reach the
oldest active device; taking that device offline must fail without reaching the
other; removing it must promote and route to the remaining device.

## Explicitly out of scope

- Per-agent device grants or a device-permissions UI.
- Automatic fallback or load balancing.
- User-selected primary devices.
- Renaming devices in the Latch UI.
- Cross-account sharing.
- Combining multiple devices behind one MCP tool namespace.
- Agent-container deployment or lifecycle changes.
