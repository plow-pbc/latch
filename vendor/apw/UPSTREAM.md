# apw — Apple Passwords CLI (vendored binary)

Upstream: https://github.com/bendews/apw — GPL-3.0-only (see LICENSE here).
Pinned release: **v1.1.1** (per-arch `deno compile` binaries published by
upstream CI; URLs + sha256 pins in `../browser-server/runtime.lock.json`,
fetched into the gitignored `vendor/apw-runtime/<arch>/apw` by
`scripts/build-browser-runtime.mjs`).

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
  Brave, or Chrome) with the **iCloud Passwords** extension installed from the
  Chrome Web Store — apw copies the extension out of that browser's profile.

## License note

apw is GPL-3.0. It ships as a **separate, unmodified executable** invoked over
its CLI (an aggregate, not a derived work); its license text is vendored here
and the pinned source is available from the upstream URL above. Do not link it
into the app or patch the binary.
