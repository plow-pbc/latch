# apw — Apple Passwords CLI (vendored binary)

Upstream: https://github.com/bendews/apw — GPL-3.0-only (see LICENSE here).
Domo runs a **fork** (`1.2.0-domo.x`, source: TODO publish — currently
`~/Projects/apw` on the dev Mac, based on upstream `9f90f01` / v1.1.1) whose
one change is that it provisions Apple's iCloud Passwords extension itself
(see below). Per-arch `deno compile` binaries; URLs + sha256 pins in
`../browser-server/runtime.lock.json`, fetched into the gitignored
`vendor/apw-runtime/<arch>/apw` by `scripts/build-browser-runtime.mjs`.
(The lock file still points at upstream v1.1.1 until the fork has a release;
for now the dev runtime binary is copied in by hand.)

## What it is

A CLI for Apple Passwords (iCloud Keychain). `apw start` runs a foreground
daemon that launches a Chromium-family browser headless with Apple's own
"iCloud Passwords" extension, which speaks Apple's native-messaging protocol
to the macOS Passwords helper
(`/Library/Google/Chrome/NativeMessagingHosts/com.apple.passwordmanager.json`,
ships with macOS 14+). Pairing is an SRP handshake confirmed by a 6-digit PIN
that macOS shows in a native dialog; the pairing lives exactly as long as the
daemon process. Queries are short-lived CLI invocations against the daemon's
Unix socket at `$HOME/.apw/apw.sock`.

Domo uses it as the Apple Passwords credential source for local browsing
(`packages/device-core/src/browser/apw.ts`, DESIGN.md §11a): the desktop app
owns the daemon lifecycle and the PIN pairing UI; `ApwCredentialBroker` maps
`pw list` / `pw get` / `otp get` onto the same `CredentialSource` surface as
the 1Password broker.

## End-user prerequisites (not bundled)

- macOS 14+ signed into iCloud with Passwords/iCloud Keychain enabled.
- A Chromium-family browser in `/Applications` (Ungoogled Chromium, Edge,
  Brave, or Chrome). Nothing needs to be installed in it: the fork downloads a
  pinned copy of Apple's iCloud Passwords extension from the Chrome Web Store
  on first launch (`apw extension fetch`; sha256-verified, unpacked to
  `~/.apw/extension`) and never reads the browser's own profile.

## Why a browser at all

Since macOS 15.4 the helper binary carries a parent-process launch
constraint: it only runs under a code-signed browser on Apple's allowlist
(`apple/password-manager-resources`, `quirks/web-browser-extension-distribution-information.json`).
The extension is merely the code that runs inside that browser; the browser is
what makes the helper accept the connection. Neither a direct stdio client
nor our bundled Camoufox can stand in for it.

## License note

apw is GPL-3.0. It ships as a **separate executable** invoked over its CLI (an
aggregate, not a derived work of the app); the fork's modified source must be
published alongside any binary we distribute, and its license text is vendored
here. Do not link it into the app or patch the binary.
