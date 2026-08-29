# Multiple Latch Installations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep several Latch installations online for one Plow account and expose every installation as a distinct hostname-named MCP server while retaining the existing primary-device URL.

**Architecture:** Plow persists a `RelayDevice` per existing Latch device identity and keys sockets and pending calls by that device ID. Device URLs route opaquely to one socket; the legacy account-UID URL resolves the oldest active device without online fallback. Latch registers its existing device ID and hostname after login, then includes the server-confirmed device ID in its relay authentication frame.

**Tech Stack:** TypeScript, Electron, Vitest, Python 3.12, FastAPI, SQLAlchemy 2, Alembic, Pydantic, pytest

## Global Constraints

- Reuse `device.identity.deviceId`; do not introduce a second local installation identity.
- Use the stable device ID in URLs and authorization; hostname is presentation metadata only.
- Every account `relay:call` credential may call every active device owned by that account.
- Keep MCP request and response bodies opaque in Plow.
- Keep `/v1/relay/devices/{account_uid}/mcp` as a no-fallback alias to the oldest active device.
- Never renumber allocated display names; collisions become `mbp (2)`, `mbp (3)`, and so on.
- Never expose credentials through renderer state, URLs, logs, or error strings.
- Deploy Plow before Latch so existing clients retain a working compatibility lane.

---

### Task 1: Persist and register relay devices in Plow

**Files:**
- Create: `../plow/api/plow/models/relay_device.py`
- Modify: `../plow/api/plow/models/__init__.py`
- Create: `../plow/api/alembic/versions/c8d7e6f5a4b3_add_relay_devices.py`
- Modify: `../plow/api/schemas/plow_schemas/api/relay.py`
- Create: `../plow/api/plow/relay/devices.py`
- Modify: `../plow/api/plow/relay/router.py`
- Modify: `../plow/api/tests/factories.py`
- Create: `../plow/api/tests/relay/test_devices.py`
- Modify: `../plow/api/tests/test_migrations.py`

**Interfaces:**
- Produces: `RelayDevice(id, user_id, device_uid, hostname, display_name, current_session_id, is_active, created_at, updated_at)`.
- Produces: `register_device(db, *, user_id: int, session_id: int, device_uid: str, hostname: str) -> RelayDevice`.
- Produces: `primary_device(db, user_id: int) -> RelayDevice | None` and `owned_active_device(db, user_id: int, device_uid: str) -> RelayDevice | None`.
- Produces: `PUT /v1/relay/devices/{device_uid}` with `RegisterRelayDeviceRequest(hostname)` and `RelayDeviceInfo`.

- [ ] **Step 1: Write failing registry and migration tests**

Cover first registration, idempotent upsert, same-ID cross-account refusal, durable hostname suffixes, reactivation with original order, oldest-active selection, and schema upgrade/downgrade. Use fixed UUID-like strings so tests never derive the expected population from the implementation's filter.

```python
first = await register_device(db_session, user_id=user.id, session_id=mac1.id, device_uid="dev_mbp", hostname="mbp")
second = await register_device(db_session, user_id=user.id, session_id=mac2.id, device_uid="dev_mbp_2", hostname="mbp")
assert (first.display_name, second.display_name) == ("mbp", "mbp (2)")
assert (await primary_device(db_session, user.id)).device_uid == "dev_mbp"
```

- [ ] **Step 2: Run the focused tests and confirm the missing model/service failure**

Run: `cd ../plow/api && uv run pytest tests/relay/test_devices.py tests/test_migrations.py -q`

Expected: collection fails because `plow.models.RelayDevice` and `plow.relay.devices` do not exist.

- [ ] **Step 3: Add the model, migration, schemas, and registry service**

Use a unique `device_uid`, a unique `(user_id, display_name)`, an indexed `(user_id, is_active, created_at)`, and a nullable foreign key to `sessions.id` for the current credential. Normalize hostname by trimming, limiting to 63 characters, and falling back to `latch`; allocate suffixes against active and inactive history.

```python
class RelayDevice(TimestampMixin, Base):
    __tablename__ = "relay_devices"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    device_uid: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    hostname: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(96))
    current_session_id: Mapped[int | None] = mapped_column(ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
```

The route must require `relay:device`, bind `auth.user_id` and `auth.session_id` rather than accepting either from the body, commit before returning, and return the device-specific MCP URL.

- [ ] **Step 4: Run registry, schema, and migration tests**

Run: `cd ../plow/api && uv run pytest tests/relay/test_devices.py tests/test_migrations.py tests/test_relay_api.py -q`

Expected: all selected tests pass.

- [ ] **Step 5: Commit the Plow registry slice**

```bash
git -C ../plow add api/plow/models/relay_device.py api/plow/models/__init__.py api/alembic/versions/c8d7e6f5a4b3_add_relay_devices.py api/schemas/plow_schemas/api/relay.py api/plow/relay/devices.py api/plow/relay/router.py api/tests/factories.py api/tests/relay/test_devices.py api/tests/test_migrations.py api/tests/test_relay_api.py
git -C ../plow commit -m "feat(relay): register persistent Latch devices"
```

### Task 2: Key Plow relay sockets and pending requests by device

**Files:**
- Modify: `../plow/api/plow/relay/ws.py`
- Modify: `../plow/api/plow/relay/pending.py`
- Modify: `../plow/api/plow/relay/ws_schemas.py`
- Modify: `../plow/api/tests/relay/test_ws_endpoint.py`
- Modify: `../plow/api/tests/relay/test_pending.py`
- Modify: `../plow/api/tests/relay/test_setup_seam.py`

**Interfaces:**
- Consumes: `RelayDevice.current_session_id`, `RelayDevice.device_uid`, and registry lookup functions from Task 1.
- Produces: auth frame field `device_id: str` and `WsRelayAuthOk(device_id: str)`.
- Produces: `PendingRequests` lifecycle methods keyed by `device_id` rather than account UID.

- [ ] **Step 1: Add failing two-device and isolation tests**

Open two WebSockets for one account with `device_id` values `dev_mbp` and `dev_mba`. Assert both manager keys remain fresh, replacing `dev_mbp` leaves `dev_mba` untouched, a response from `dev_mba` cannot resolve a `dev_mbp` request ID, and revoking the MBP session closes only MBP.

```python
_handshake(mbp_ws, _MAC1_TOKEN, device_id="dev_mbp")
_handshake(mba_ws, _MAC2_TOKEN, device_id="dev_mba")
assert cm.is_connected("dev_mbp", client_kind=RELAY_DEVICE_CLIENT_KIND)
assert cm.is_connected("dev_mba", client_kind=RELAY_DEVICE_CLIENT_KIND)
```

- [ ] **Step 2: Run the focused relay tests and confirm the second socket evicts the first**

Run: `cd ../plow/api && uv run pytest tests/relay/test_ws_endpoint.py tests/relay/test_pending.py tests/relay/test_setup_seam.py -q`

Expected: the new two-device assertions fail because registration is still keyed by account UID.

- [ ] **Step 3: Authenticate and track exact device identities**

Parse `device_id` from the auth frame, load the active device under the lifecycle lock, require its user and `current_session_id` to match the authenticated session, and register/attach under `device.device_uid`. Keep `account_id` in `auth.ok` for compatibility and add `device_id`. Change pending entry and diagnostic field names from account-oriented `device_uid` to the actual stable device ID.

Legacy frames without `device_id` may connect only when the account has zero or one active device; map them to the sole device when present, or a temporary account alias key when no device has registered yet. Reject them once two active records exist with the fixed reason `Latch must be upgraded for multiple installations`.

- [ ] **Step 4: Run relay lifecycle tests**

Run: `cd ../plow/api && uv run pytest tests/relay/test_ws_endpoint.py tests/relay/test_pending.py tests/relay/test_setup_seam.py -q`

Expected: all selected tests pass, including legacy one-device coverage.

- [ ] **Step 5: Commit device-keyed sockets**

```bash
git -C ../plow add api/plow/relay/ws.py api/plow/relay/pending.py api/plow/relay/ws_schemas.py api/tests/relay/test_ws_endpoint.py api/tests/relay/test_pending.py api/tests/relay/test_setup_seam.py
git -C ../plow commit -m "feat(relay): keep one socket per Latch device"
```

### Task 3: Route MCP calls to device URLs and the primary alias

**Files:**
- Modify: `../plow/api/plow/relay/mcp.py`
- Modify: `../plow/api/plow/relay/router.py`
- Modify: `../plow/api/plow/alerts/middleware.py`
- Modify: `../plow/api/plow/relay/oauth/challenge.py`
- Modify: `../plow/api/plow/relay/oauth/router.py`
- Modify: `../plow/api/tests/relay/test_mcp_endpoint.py`
- Modify: `../plow/api/tests/relay/test_oauth.py`
- Modify: `../plow/api/tests/relay/test_route_order.py`

**Interfaces:**
- Consumes: `owned_active_device` and `primary_device` from Task 1; device-keyed `PendingRequests` from Task 2.
- Produces: one route whose path segment resolves as account alias when equal to caller UID, otherwise as a stable device ID.

- [ ] **Step 1: Add failing device-specific and no-fallback tests**

Prove each URL reaches only its named socket, a different account sees `403`, an inactive owned device sees `404`, and an offline primary alias returns `503` naming the primary without sending to an online secondary. Assert a non-JSON body is replayed byte-for-byte so routing never parses MCP.

```python
response = client.post(f"/v1/relay/devices/{mbp.device_uid}/mcp", content=b"not-json", headers=agent_auth)
assert received_by_mbp.body == "not-json"
assert received_by_mba is None
```

- [ ] **Step 2: Run endpoint tests and confirm device IDs are rejected by the account-UID guard**

Run: `cd ../plow/api && uv run pytest tests/relay/test_mcp_endpoint.py tests/relay/test_oauth.py tests/relay/test_route_order.py -q`

Expected: new device-specific routing tests fail with `403` or no matching socket.

- [ ] **Step 3: Resolve the target before constructing the opaque frame**

Replace `if device_uid != caller_uid` with an async resolver. Return fixed non-disclosing errors and use the safe display name only for an owned offline device. Key session revalidation, socket teardown, pending capacity, logs, and correlation by `target.device_uid`. Preserve the request path and body exactly as received.

Update OAuth protected-resource validation so both the account alias and owned active device IDs are valid resources for the caller; never authorize a device from another account.

- [ ] **Step 4: Run endpoint and OAuth tests**

Run: `cd ../plow/api && uv run pytest tests/relay/test_mcp_endpoint.py tests/relay/test_oauth.py tests/relay/test_route_order.py -q`

Expected: all selected tests pass.

- [ ] **Step 5: Commit device routing**

```bash
git -C ../plow add api/plow/relay/mcp.py api/plow/relay/router.py api/plow/alerts/middleware.py api/plow/relay/oauth/challenge.py api/plow/relay/oauth/router.py api/tests/relay/test_mcp_endpoint.py api/tests/relay/test_oauth.py api/tests/relay/test_route_order.py
git -C ../plow commit -m "feat(relay): route MCP to named Latch devices"
```

### Task 4: Return device rosters and multi-server connector configs

**Files:**
- Modify: `../plow/api/schemas/plow_schemas/api/relay.py`
- Modify: `../plow/api/plow/relay/router.py`
- Modify: `../plow/api/tests/test_relay_api.py`
- Modify: `../plow/api/tests/relay/test_setup_seam.py`

**Interfaces:**
- Produces: `RelayInfo.devices: list[RelayDeviceInfo]` while preserving `uid`, `mcp_url`, and `device_connected` for the primary alias.
- Produces: `CreateAgentResponse.mcp_config` containing one server per active device, while `mcp_url` remains the account alias.

- [ ] **Step 1: Add failing API contract tests**

Register MBP and MBA, mint one agent, and assert the config contains `plow-mbp` and `plow-mba`, both use the one newly minted bearer token, and each URL contains its stable device ID. Assert `relay/info` orders primary first and reports connection state per device.

```python
servers = json.loads(created["mcp_config"])["mcpServers"]
assert list(servers) == ["plow-mbp", "plow-mba"]
assert {v["headers"]["Authorization"] for v in servers.values()} == {f"Bearer {created['token']}"}
```

- [ ] **Step 2: Run API tests and confirm only the account alias is returned**

Run: `cd ../plow/api && uv run pytest tests/test_relay_api.py tests/relay/test_setup_seam.py -q`

Expected: new device roster and multi-server assertions fail.

- [ ] **Step 3: Generate deterministic connector entries**

Load all active devices ordered by creation time. Slug display names to lowercase ASCII `[a-z0-9-]`; when two display names slug identically, append the first eight characters of `device_uid`. Keep the existing single `plow` account-alias config only when no registered device exists, for rollout compatibility. Preserve server-authored URLs and place the token only in the Authorization headers.

- [ ] **Step 4: Run API and setup-seam tests**

Run: `cd ../plow/api && uv run pytest tests/test_relay_api.py tests/relay/test_setup_seam.py -q`

Expected: all selected tests pass.

- [ ] **Step 5: Commit discovery and connector output**

```bash
git -C ../plow add api/schemas/plow_schemas/api/relay.py api/plow/relay/router.py api/tests/test_relay_api.py api/tests/relay/test_setup_seam.py
git -C ../plow commit -m "feat(relay): emit one MCP server per Latch"
```

### Task 5: Register Latch identity during login

**Files:**
- Modify: `apps/desktop/src/plowApi.ts`
- Modify: `apps/desktop/src/onboarding.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/settings.ts`
- Modify: `apps/desktop/src/settingsActions.ts`
- Modify: `apps/desktop/test/plowApi.test.ts`
- Modify: `apps/desktop/test/onboarding.test.ts`
- Modify: `apps/desktop/test/settings.test.ts`
- Modify: `apps/desktop/test/settingsActions.test.ts`

**Interfaces:**
- Consumes: `PUT /v1/relay/devices/{device_uid}` and `RelayDeviceInfo` from Task 1.
- Produces: `PlowApi.registerRelayDevice(token, deviceId, hostname): Promise<RelayDeviceInfo>`.
- Produces: persisted `relayDeviceId`, `relayDeviceName`, and device-specific `mcpUrl` fields, cleared on sign-out.

- [ ] **Step 1: Write failing API and onboarding tests**

Assert URL encoding, `{hostname}` body shape, defensive response parsing, and the sequence `relayInfo -> registerRelayDevice -> save -> startRelay`. Drive registration failure and assert no credential or device metadata is saved and the UI does not report connected.

```ts
expect(api.calls).toEqual([
  ["relayInfo", sessionToken],
  ["registerRelayDevice", sessionToken, "device-1", "mbp"],
]);
```

- [ ] **Step 2: Run tests and confirm the method and dependency fields are absent**

Run: `npx vitest run apps/desktop/test/plowApi.test.ts apps/desktop/test/onboarding.test.ts apps/desktop/test/settings.test.ts apps/desktop/test/settingsActions.test.ts`

Expected: TypeScript compilation fails on `registerRelayDevice` and new settings fields.

- [ ] **Step 3: Add registration and sequence it before relay startup**

Pass `device.identity.deviceId` and `hostName()` into `Onboarding` dependencies from `main.ts`. Register after learning the account but before persisting the session; accept only a response whose `device_id` exactly equals the requested local identity. Save the server display name and device-specific MCP URL. Keep account UID and account-alias URL separately for compatibility display.

- [ ] **Step 4: Run the focused Latch tests**

Run: `npx vitest run apps/desktop/test/plowApi.test.ts apps/desktop/test/onboarding.test.ts apps/desktop/test/settings.test.ts apps/desktop/test/settingsActions.test.ts`

Expected: all selected tests pass.

- [ ] **Step 5: Commit registration**

```bash
git add apps/desktop/src/plowApi.ts apps/desktop/src/onboarding.ts apps/desktop/src/main.ts apps/desktop/src/settings.ts apps/desktop/src/settingsActions.ts apps/desktop/test/plowApi.test.ts apps/desktop/test/onboarding.test.ts apps/desktop/test/settings.test.ts apps/desktop/test/settingsActions.test.ts
git commit -m "feat(desktop): register this Latch installation"
```

### Task 6: Authenticate the Latch socket as its registered device

**Files:**
- Modify: `packages/relay-client/src/client.ts`
- Modify: `packages/relay-client/src/wire.ts`
- Modify: `packages/relay-client/test/wire.test.ts`
- Modify: `packages/relay-client/test/lifecycle.test.ts`
- Modify: `packages/relay-client/test/liveness.test.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/test/settings.test.ts`

**Interfaces:**
- Consumes: persisted `relayDeviceId` from Task 5.
- Produces: `RelayClientOptions.deviceId: string` and auth frame `{type: "auth", token, client_kind: "relay-device", device_id}`.

- [ ] **Step 1: Add failing wire and lifecycle assertions**

Capture the authentication frame and assert `device_id` is present, the credential remains absent from logs, and an empty device ID prevents dialing rather than falling back to the legacy account socket.

```ts
expect(JSON.parse(conn.sent[0])).toMatchObject({
  type: "auth",
  token: "plow_device",
  device_id: "device-1",
});
```

- [ ] **Step 2: Run relay-client tests and confirm the auth frame lacks the device**

Run: `npx vitest run packages/relay-client/test apps/desktop/test/settings.test.ts`

Expected: the new auth-frame assertion fails.

- [ ] **Step 3: Require the registered identity in RelayClient**

Add a non-empty `deviceId` option, include it in the post-challenge auth frame, and keep `auth.ok.device_id` parsing optional only for the server rollout window. In `startRelay`, require both credential and saved device ID; on a mismatch response, stop and re-run registration rather than serving as a different installation.

- [ ] **Step 4: Run relay-client and desktop tests**

Run: `npx vitest run packages/relay-client/test apps/desktop/test/settings.test.ts apps/desktop/test/onboarding.test.ts`

Expected: all selected tests pass.

- [ ] **Step 5: Commit device-aware socket auth**

```bash
git add packages/relay-client/src/client.ts packages/relay-client/src/wire.ts packages/relay-client/test/wire.test.ts packages/relay-client/test/lifecycle.test.ts packages/relay-client/test/liveness.test.ts apps/desktop/src/main.ts apps/desktop/test/settings.test.ts
git commit -m "feat(relay-client): authenticate the exact Latch device"
```

### Task 7: Consume server-authored multi-device MCP config in Latch

**Files:**
- Modify: `apps/desktop/src/plowApi.ts`
- Modify: `apps/desktop/src/connectClient.ts`
- Modify: `apps/desktop/test/plowApi.test.ts`
- Modify: `apps/desktop/test/connectClient.test.ts`

**Interfaces:**
- Consumes: `CreateAgentResponse.mcp_config` from Task 4.
- Produces: `MintedCredential.mcpConfig: string`; `ConnectClient` displays this exact server-authored config after credential-echo validation.

- [ ] **Step 1: Add failing server-config tests**

Return a config containing `plow-mbp` and `plow-mba` from the fake API and assert the shown-once `ClientCredential.config` contains both. Return a config that omits the minted token or contains an unexpected credential-shaped value and assert it is refused with a fixed local error.

- [ ] **Step 2: Run focused tests and confirm ConnectClient still constructs one local entry**

Run: `npx vitest run apps/desktop/test/plowApi.test.ts apps/desktop/test/connectClient.test.ts`

Expected: the multi-server assertion fails because `agentConfig(settings.mcpUrl, minted.token)` emits only `plow`.

- [ ] **Step 3: Parse and show the server-authored config**

Carry `mcp_config` through the main-process-only API model. Parse it as JSON, require a non-empty `mcpServers` object, require every Authorization value to equal `Bearer ${minted.token}`, reject any string field that echoes a different `plow_` credential, then show the original string. Delete the now-obsolete local `agentConfig` builder.

- [ ] **Step 4: Run ConnectClient tests**

Run: `npx vitest run apps/desktop/test/plowApi.test.ts apps/desktop/test/connectClient.test.ts`

Expected: all selected tests pass.

- [ ] **Step 5: Commit multi-device connector consumption**

```bash
git add apps/desktop/src/plowApi.ts apps/desktop/src/connectClient.ts apps/desktop/test/plowApi.test.ts apps/desktop/test/connectClient.test.ts
git commit -m "feat(desktop): show every Latch MCP connector"
```

### Task 8: Canonical verification and cross-repository integration

**Files:**
- Modify: `README-ts.md`
- Modify: `../plow/api/tests/relay/test_setup_seam.py`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified two-device behavior and release-order documentation.

- [ ] **Step 1: Run the complete Latch gate**

Run: `just test`

Expected: TypeScript build and all Vitest suites pass with no new skips or suppressed failures.

- [ ] **Step 2: Run the complete Plow API gate**

Run: `cd ../plow/api && uv run ruff check . && uv run basedpyright && uv run pytest -q`

Expected: lint, strict type checking, migration checks, and the full API suite pass.

- [ ] **Step 3: Run the two-device setup seam**

Run: `cd ../plow/api && uv run pytest tests/relay/test_setup_seam.py -q -k 'multiple or device or primary'`

Expected: two sockets remain connected; each stable URL reaches only its device; the alias reaches the oldest active device; taking it offline yields `503` without sending to the secondary; deactivating it promotes and routes to the secondary.

- [ ] **Step 4: Update architecture documentation with only observed behavior**

Document that the MCP surface is per installation, the compatibility alias is primary-only, and connector configs contain one entry per active device. Remove any statement that says one account has exactly one Mac socket.

- [ ] **Step 5: Re-run documentation-sensitive and canonical checks**

Run: `git diff --check && just test`

Run: `git -C ../plow diff --check && cd ../plow/api && uv run ruff check . && uv run basedpyright && uv run pytest -q`

Expected: every command exits zero.

- [ ] **Step 6: Commit final documentation separately in each changed repository**

```bash
git add README-ts.md
git commit -m "docs: describe named Latch device connectors"
git -C ../plow add api/tests/relay/test_setup_seam.py
git -C ../plow commit -m "test(relay): prove multi-device setup end to end"
```

### Task 9: Open and converge the pull requests

**Files:**
- No source files unless exact-head review finds a verified defect.

**Interfaces:**
- Produces: one converged Plow PR and one converged Latch PR, with the Latch PR declaring the Plow rollout dependency.

- [ ] **Step 1: Re-fetch both repositories and inspect exact branch state**

Run: `git fetch origin && git status --short --branch && git log -1 --oneline`

Run: `git -C ../plow fetch origin && git -C ../plow status --short --branch && git -C ../plow log -1 --oneline`

Expected: only intended files are present and both feature branches are ahead of current remote bases.

- [ ] **Step 2: Push and open both PRs**

Push explicit feature branches, open Plow first, then open Latch with the Plow PR URL and required deploy order in its body. Do not merge either PR without separate authorization.

- [ ] **Step 3: Invoke `$babysit-pr` for the Plow PR**

Review the exact current head, resolve only verified findings, re-run the canonical gate after every push, and continue until the PR reports exact-head convergence.

- [ ] **Step 4: Invoke `$babysit-pr` for the Latch PR**

Repeat the same exact-head loop. Any push invalidates earlier convergence; re-review the new SHA.

- [ ] **Step 5: Re-fetch final PR state**

Expected: both PRs are open, CI is green, required review is clean on the exact head SHA, and neither has been merged without authorization.
