# feature/msgvault — message-archive search for remote agents

Status as of 2026-09-16: feature complete and green (full suite passes,
`just verify-preload` passes, a signed universal package built and verified).
Everything is UNCOMMITTED working-tree state on top of main at `a19d6b5`.
Delete this file before merging.

## What this branch does

Bundles the [msgvault](https://github.com/kenn-io/msgvault) CLI (MIT, v0.19.3)
so remote agents can search and read the owner's local message archive, and
gives the owner an iMessage import flow. Three pieces:

1. **Agent tools** in `@domo/mcp-server`: `plow_msgvault_search`,
   `plow_msgvault_get_message`, `plow_msgvault_stats`. All read-only, all
   deferrable, all sharing ONE capability `{ kind: "msgvault", access: "read" }`
   so a single always-allow rule covers every archive query. Query text rides
   in the payload after a `--` argv terminator, so agent strings can never
   become flags. A `msgvault-messages` skill teaches agents the syntax.
2. **Device subsystem** `packages/device-core/src/msgvault/`: runtime resolver
   (test seam `DOMO_MSGVAULT_CMD`, then packaged `Resources/msgvault/<arch>/`,
   then repo `vendor/msgvault/`; a system msgvault is deliberately IGNORED
   because its version is untested by us), an `execFile` client wrapper, and
   the `executeMsgvault` dispatch in `DeviceAgent`. msgvault runs OUTSIDE the
   seatbelt executor because a sandbox-exec child cannot use the app's Full
   Disk Access grant, and msgvault detaches its own daemon. The archive lives
   at `$DOMO_HOME/msgvault` (hermetic per instance); the daemon is stopped on
   app quit.
3. **Owner UI**: a "Message Archive" row in Settings → Capabilities (main's
   group, beside Full Disk Access and Launch at Login): binary status, an
   Import iMessages button, last-run result. Import is owner-only (no agent
   tool), capped by `IMESSAGE_IMPORT_LIMIT = 100` in
   `apps/desktop/src/msgvaultImport.ts`, raise it there when ready. FDA
   status and the System Settings deep link are main's own (#54); this branch
   only gates the import button on them.

Full rationale is in DESIGN.md §11c. New capability kind touches
`packages/protocol/src/capability.ts` (no golden-vector change, verified).

## Vendoring and packaging

- Pins: `vendor/msgvault.lock.json` (per-arch tarball URLs + sha256, LICENSE).
  Updates are a manual pin bump.
- Fetch: `just fetch-msgvault` (host arch) / `scripts/fetch-msgvault.mjs
  --both` (packaging; wired into `_package`).
- electron-builder: `extraResources` ships `vendor/msgvault` per-arch thin
  binaries; `x64ArchFiles` passes them through the universal merge;
  `signIgnore` uses `Resources/msgvault/.*` ANCHORED on purpose, because a
  bare `msgvault/.*` regex also matches a checkout directory named msgvault
  and then nothing in the app gets signed. `afterPack.cjs` section 4d signs
  the binaries with helper entitlements and verifies them.

## Tests

All fake-binary based (`e2e/fixtures/fakeMsgvault.cjs`), no real msgvault and
no chat.db needed: `packages/protocol/test/msgvault.test.ts`,
`packages/device-core/test/msgvault.test.ts`,
`packages/mcp-server/test/msgvault.test.ts`,
`apps/desktop/test/msgvaultImport.test.ts`, plus viewModel/approval additions.

## Known loose ends

- Real-world FDA flow untested: this dev machine has SIP disabled, so TCC
  never denies and the grant flow never engages. Verify on a SIP-enabled Mac,
  including that the app's FDA grant covers the spawned msgvault daemon
  (TCC responsible-process attribution, expected to work, never observed).
- A notarized `just package` has not run, only `package-unnotarized`
  (signatures verified clean, so notarization should pass).
- `msgvault stats` has no `--json` upstream; the client falls back to
  `{ text }`. Search/show-message parse real JSON.
- Import limit is 100 for testing; the owner asked to raise it later.
