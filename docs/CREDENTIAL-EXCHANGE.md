# Credential exchange: receiving an Apple Passwords export app-to-app

macOS 26 added a FIDO-Alliance-designed, app-to-app credential transfer:
Apple Passwords (26.4+) offers **File → Export to Another App…**, the system
shows the installed apps that can receive, the owner authenticates, and the
credentials move process-to-process — no plain-text CSV ever touches disk.
This app can be such a destination. The decisions live in DESIGN.md §11a-iii;
this file is the mechanical reference: the moving pieces, the wire schema,
the packaging switch, and how to test it.

## The flow, end to end

1. The owner picks "Plow Latch" in Apple Passwords' export sheet and
   authenticates (Touch ID / password — the system's UI, not ours).
2. macOS launches or foregrounds the app with an `NSUserActivity` of type
   `ASCredentialExchangeActivity`; its userInfo carries a one-shot import
   token (a UUID). Electron surfaces this as `app.on("continue-activity")` —
   see the credential-exchange section of `apps/desktop/src/main.ts`. AppKit
   only delivers the activity because the packaged Info.plist declares the
   type under `NSUserActivityTypes` (electron-builder.yml `extendInfo`); a
   from-source run is the stock Electron.app and never receives one.
3. Main redeems the token in-process: `ASCredentialImportManager` and every
   `ASImportable*` type are **Swift-only** API, so the call lives in a Swift
   shim (`apps/desktop/native/credential-import.swift`, built into
   `Resources/native/libdomo-credential-import.dylib`) that the N-API addon
   `@domo/native-credential-import` dlopens. The system runs its own consent
   UI inside the call and answers with the exported credentials.
4. The shim transcribes Apple's types into a small **versioned wire JSON of
   ours** (deliberately not `JSONEncoder` over Apple's types, whose encoding
   is Apple's to change). `parseCredentialExchange` in
   `packages/device-core/src/browser/credentialExchange.ts` — pure, vitest-
   covered, schema frozen by `test/credentialExchange.test.ts` — turns it
   into the same `ImportedLogin[]` the Vault tab's Import sheet stages.
5. From there it IS the import flow the Vault tab already had: logins staged
   in main, `markAgainstVault` dedupe/update classification, a secret-free
   preview pushed to the renderer (`vault:exchange` + `vault:exchangePending`),
   the Import sheet opening straight on it, commit through `importLogins` —
   ordinary saves, ordinary audit lines.

Passkeys, credit cards, identities and the rest of the exchange's credential
types have no home in this vault; they are **named to the owner** (per-row
warnings, or a skip reason for items that are only that) and never silently
dropped. TOTP keys come across, spelled bare-base32 or as an `otpauth://` URI
when their parameters are off-default.

The Import sheet's own Apple Passwords guidance advertises this flow (ahead
of the CSV walk) when `vault:importSources` says the Passwords app has the
menu at all (`passwordsAppCanHandOff`, macOS 26.4+) — and, for a PACKAGED
install, only if the build also shipped the appex, addon and shim, because a
real install offering steps whose Select Destination dialog would not list
the app is worse than offering none. A from-source run shows the steps on OS
alone even though it can never receive (stock Info.plist, no entitlement):
that is how the guidance is worked on and screenshotted.

## OS floors, and what runs where

- The APIs exist on **macOS 26.0+**; Apple Passwords grew the export UI in
  **26.4**. The app itself still runs on macOS 15: every 26-only symbol is
  weak-linked behind `#available` guards in the shim (built with a macOS 13
  target — verified loadable anywhere), the addon's `osSupported()` gates the
  call, and the extension bundle's `LSMinimumSystemVersion 26.0` keeps it
  inert bytes on older systems.
- Missing addon, missing shim, old OS, expired token — each is one error
  dialog ("Couldn't receive passwords"), never a crash and never a hang.

## The extension that vends nothing

macOS lists an app as an export destination only if it carries an AutoFill
credential-provider extension advertising `SupportsCredentialExchange` —
that Info.plist dictionary is the registration mechanism, and there is no
import-only variant. So the app ships
`Contents/PlugIns/PlowLatchCredentialProvider.appex`
(`apps/desktop/native/credential-provider/`), and it deliberately vends
nothing: no `ProvidesPasswords`/`ProvidesPasskeys` capability keys, and every
provider entry point cancels immediately. The vault's values stay
owner-typed and broker-filled (DESIGN.md §11a); the system AutoFill UI is
never offered them.

If a macOS release turns out to require a `Provides*` capability before it
lists the app in the export sheet, the knob is
`native/credential-provider/Info.plist` — add `ProvidesPasswords = true`
under `ASCredentialProviderExtensionCapabilities`. The extension still vends
nothing (every request is cancelled, and nothing is offered until the owner
also enables it in System Settings → AutoFill), but prefer shipping without
it until proven necessary.

## The packaging switch: profile capability, not profile presence

`com.apple.developer.authentication-services.autofill-credential-provider`
is a **profile-backed entitlement**: under Developer ID it must be authorized
by an embedded provisioning profile or the app is killed at launch. The app
already ships a checked-in Developer ID profile either way —
`build/PlowLatch-DeveloperID.provisionprofile`, always embedded, because the
vault's keychain entitlements need one — so mere existence proves nothing.
`just package` therefore decodes the profiles (`security cms -D`) and turns
the feature ON only when **both** actually grant the AutoFill capability:

    build/PlowLatch-DeveloperID.provisionprofile
        the app's existing profile, REGENERATED to carry the capability
    build/PlowLatchCredentialProvider-DeveloperID.provisionprofile
        a new profile for co.plow.domo-desktop.credential-provider (check it in)

Getting there (Apple Developer portal, once per account):

1. Identifiers → `co.plow.domo-desktop`: enable the **AutoFill Credential
   Provider** capability. Register `co.plow.domo-desktop.credential-provider`
   and enable it there too.
2. Profiles → the existing Developer ID profile for the app is now invalid
   (its identifier changed capabilities): edit/regenerate it, download, and
   **replace** the checked-in `PlowLatch-DeveloperID.provisionprofile`. Then a
   new **Developer ID** profile for the extension identifier, against the same
   "Developer ID Application" certificate
   (`The Plow Collective, Inc (3559PD337Z)`); download and check it in as
   `PlowLatchCredentialProvider-DeveloperID.provisionprofile`.

With both granting the capability, `just package` says
`credential exchange: ON` and:

- signs the app with `build/entitlements.mac.import.plist` — the base set plus
  the AutoFill entitlement (KEEP ITS COMMON PART IN STEP with
  `entitlements.mac.plist`); the always-embedded app profile authorizes it;
- `build/afterPack.cjs` copies the built appex under `Contents/PlugIns`,
  stamps the app's `CFBundleVersion`/`CFBundleShortVersionString` into it,
  embeds the extension profile, checks both arches, and signs it with
  `build/entitlements.appex.plist` (electron-builder's own signer is kept off
  it via `signIgnore` — it would strip the entitlements and profile).

Otherwise the recipe prints exactly which half is missing and the package is
byte-for-byte the app without the feature: no new entitlement, no PlugIns,
nothing for an unauthorized entitlement to kill. The `NSUserActivityTypes` Info.plist entry
ships either way and is harmless alone.

## Testing

- `npx vitest run packages/device-core/test/credentialExchange.test.ts` — the
  wire schema and every mapping rule (this is what freezes the Swift shim's
  output contract; a shim change that breaks these is a contract change).
- The native chain shy of a real token can be driven from plain node:
  `require("@domo/native-credential-import")
  .importCredentials("<dist/native/libdomo-credential-import.dylib>", "<any UUID>")`
  must reject with AuthenticationServices error 1004 (invalid token) — that
  proves dlopen, the OS gate, the real system call and the promise plumbing.
- The whole flow is a **manual run on the dedicated test machine** (macOS
  26.4+, packaged install with profiles): Apple Passwords → File → Export to
  Another App… → the app should be listed; pick it; expect the Vault tab
  with the Import sheet open on a preview, then commit and check
  `audit.ndjson` for the ordinary vault-save lines. Trying it from source
  cannot work (stock Electron Info.plist, no entitlement) and launching the
  app on the head chef's Mac is off-limits as ever.

## Troubleshooting

- **App not listed in the export sheet** — it isn't a packaged install with
  profiles (`credential exchange: ON` in the package log), or the OS wants a
  `Provides*` capability (see the knob above), or the appex was rejected:
  `codesign -dv --entitlements - <app>/Contents/PlugIns/*.appex` and check
  `pluginkit -m -p com.apple.authentication-services-credential-provider-ui`
  lists `co.plow.domo-desktop.credential-provider`.
- **App launches then "Couldn't receive passwords: …error 1004"** — the token
  was redeemed twice or expired; re-run the export from Passwords.
- **App killed at launch after packaging** — an entitlements/profile
  mismatch: the profile files don't cover the identifiers or capability, or
  `entitlements.mac.import.plist` drifted from `entitlements.mac.plist`'s
  common part.
