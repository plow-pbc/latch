# feature/apw-part-2 — Apple Passwords, part 2

State of this branch as of 2026-09-16. Written so it can be picked up cold.

## What the branch does

Adds Apple Passwords (iCloud Keychain) as a credential source for local
browsing, via the vendored `apw` CLI (DESIGN.md §11a, `vendor/apw/UPSTREAM.md`).
Committed work: the daemon + PIN pairing lifecycle owned by the desktop app,
a dismissible pairing banner, AutoFill consent warm-up, real audit statuses,
and Settings prerequisite explanations.

## Uncommitted work in this worktree: extension self-provisioning

The working tree removes the "Get the Extension" setup step. Users previously
had to install Apple's iCloud Passwords extension into Chrome by hand; now a
**forked apw** downloads a pinned copy from the Chrome Web Store itself.

- `applePasswords.ts`: `ApwPrereqs` is just `{ browser }` now. The browser
  profile scan, `extensionInstalled`, `browserApp`, and the extension URL are
  gone.
- `main.ts` / `preload.cts`: `applePasswords:openExtensionPage` IPC removed.
- `renderer/main.js`: error state offers only "Get Google Chrome" when no
  Chromium-family browser exists, otherwise shows the apw error.
- `test/applePasswords.test.ts`: prereq tests reduced to match.
- `vendor/apw/UPSTREAM.md`: documents the fork and the "why a browser" story.

Verified: `just build`, `npx vitest run apps/desktop` (124/124),
`just verify-preload`, and a live end-to-end pairing challenge on this Mac.

## The apw fork (NOT in this repo)

Lives at `~/Projects/apw`, uncommitted, based on upstream `bendews/apw`
`9f90f01` (v1.1.1), version `1.2.0-domo.1`. Changes:

- New `src/extension.ts`: `EXTENSION_PIN` (id / version 3.3.0 / exact CRX blob
  URL / sha256), `provisionExtension()` (fetch or `APW_EXTENSION_CRX` local
  file, sha256-verify, strip CRX3 envelope, unzip, drop `_metadata/`, check
  manifest version + store `key`, atomic rename into `~/.apw/extension`),
  `latestExtension()` for pin bumps.
- `src/browser.ts`: profile scan replaced by the provisioner; bridge injection
  unchanged.
- CLI: `apw extension fetch|status|latest`.
- Bugfix: `writeConfig` creates `~/.apw` (fresh-home `apw start -b chrome`
  crashed upstream).
- Tests: `src/extension_test.ts` (3 tests). `deno fmt/lint/check/test` clean
  with deno 2.9.x.

The fork's compiled binary was copied by hand into the gitignored
`vendor/apw-runtime/arm64/apw` in THIS worktree only.

## Why apw needs a browser at all (research findings)

`PasswordManagerBrowserExtensionHelper` is a stdio native-messaging host, but
since macOS 15.4 it carries a kernel-enforced parent-process launch constraint:
the parent must be a code-signed browser on Apple's allowlist
(`apple/password-manager-resources`,
`quirks/web-browser-extension-distribution-information.json`), or hold the
Apple-granted web-browser WebAuthn entitlement. Consequences:

- Direct stdio clients (e.g. `kezhenxu94/ipass`) are dead on 15.4+.
- Our bundled Camoufox cannot stand in (not allowlisted, not Mozilla-signed),
  so the "use Camoufox instead of Chrome" idea was investigated and rejected.
- The extension itself is only the code that runs inside the trusted browser;
  the browser exists purely to borrow its signature. Firefox is allowlisted
  and Apple ships a Firefox XPI + native-messaging manifest, so real Firefox
  is a possible future host.

## Before this branch can merge

1. Host the apw fork (org/repo TBD), commit + push `~/Projects/apw`, cut a
   release with per-arch `deno compile` binaries (GPL-3: fork source must be
   published).
2. Point `vendor/browser-server/runtime.lock.json` `apw` pins at that release
   (it still points at upstream v1.1.1; a clean checkout or `just package`
   would fetch upstream, which now fails because the app no longer checks for
   a profile-installed extension).
3. Update `vendor/apw/UPSTREAM.md` "TODO publish" line with the real repo.
4. Optional follow-ups: `apw extension fetch` with a "downloading…" Settings
   state; ship the CRX in the DMG via `APW_EXTENSION_CRX`; Firefox as a host;
   file the long-shot Apple allowlist PR for Domo.

## Behavior notes

- First enable downloads the pinned CRX (~500 KB) into `~/.apw/extension`;
  cached afterward. An upstream-era `~/.apw` gets re-provisioned once.
- Tampered/mismatched CRX is refused and never clobbers the installed copy.
- Delete this file before merging.
