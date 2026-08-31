# The vault: how it works

The vault is where this Mac keeps the owner's logins, cards, identities and
secure notes — the things an agent may ask to have typed into a page, and the
things the owner manages in the app's **Vault** tab. It is entirely local: an
encrypted item file plus one master key rooted in the macOS Keychain. There is
no server, no separate password-manager process, and no account.

This document is the mechanical reference — what is on disk, who reads it, and
what each path guarantees. The *decisions* behind it (and their history,
including the Bitwarden stack this replaced and the app-rename incident that
shaped the Keychain handling) live in [DESIGN.md](../DESIGN.md) §11a and
§11a-i; this file does not repeat the rationale.

All code lives in `packages/device-core/src/browser/`, file names given
per-section below.

## The one-paragraph version

Items are Bitwarden-format ciphers in `items.json`, every field an EncString
(AES-256-CBC + HMAC-SHA256) under a per-item key that is itself wrapped by one
64-byte **master key**. The master key lives in the macOS Keychain — via a
SecItem access group in the packaged app, via Electron `safeStorage` under
`just app`, via a 0600 file in tests. The owner reads and writes items through
`LocalVault` (the Vault tab); the agent gets values only through the in-process
credential broker (`BrokerCore`), which binds every release to the page being
filled, refuses a login off its own site, and audits every release without
ever logging a value.

## On disk

Everything sits in one directory, `$DOMO_HOME/device/browser/vault/`:

| File | What it is | Written by |
|---|---|---|
| `items.json` | `{version: 1, ciphers: [...]}` — Bitwarden-format cipher rows, every string field an EncString. 0600, written atomically (tmp + rename). | `vaultStore.ts` |
| `vault-key.enc` | The master-key blob. A 5-byte marker names the provider (`KSEC1` / `KENC1` / `KRAW1`), then the provider's payload. 0600. | `vaultKeyStore.ts` |
| `db.sqlite3`, `vault-account.enc`, … | The OLD Bitwarden vault, when this machine had one. Never written again; kept as the owner's backup after migration. | (legacy) |
| `credential-audit.log` | One line per describe/release/reveal — item id, field label, page, outcome. **Never a value.** | `localVault.ts`, `brokerCore.ts` |

The item file holds ciphertext and structure only, so its confidentiality
floor is the key's, not the disk's. What IS visible in `items.json`: how many
items exist, their types, and their revision dates — names, usernames, URLs
and all field values are EncStrings.

### The item format (`vaultItems.ts`)

Bitwarden's cipher shape, kept deliberately: types 1–4 (login, secure note,
card, identity), each field an EncString `2.<iv>|<ct>|<mac>` (base64). Newer
items carry their own 64-byte item key, wrapped by the master key
(`cipher.key`); older/migrated ones may be encrypted with the master key
directly — both are read, and an item is always written back under the key it
already had. Login URLs carry the checksum other Bitwarden clients verify, so
the data would still be portable. `staleEdit` compares the revision a form was
opened on against the stored `revisionDate` and refuses a save composed
against an item that changed underneath it.

The broker can additionally *read* shapes the app's forms refuse to create —
SSH keys (type 5), custom fields, linked fields — because a migrated vault may
hold them (`decryptRaw`).

## The master key (`vaultKeyStore.ts`)

One 64 random bytes: the first 32 are the AES key, the last 32 the HMAC key
(`splitKey`). It is minted on the vault's first use and never rotates. Three
providers can hold it; the provider is chosen once at write time and recorded
in the blob's marker, so a key written under one provider is never silently
re-read through another:

1. **`KSEC1` — SecItem + access group** (packaged app only). The key is a
   generic password in the data-protection Keychain: service `co.plow.vault`,
   access group `3559PD337Z.co.plow.vault` — both frozen literals, chosen so
   the item is keyed to our signing identity's group rather than to a bundle
   id or product name that could be renamed. Reached through
   `packages/native-keychain` (a ~150-line N-API addon over
   `SecItemCopyMatching`/`SecItemAdd`); requires the `keychain-access-groups`
   entitlement in `entitlements.mac.plist`, so only the signed, packaged app
   can select it — the runtime probe returns `missing-entitlement` everywhere
   else and the store falls through. Gated to `app.isPackaged` besides, so a
   dev run or a test can never write into the real login Keychain.
2. **`KENC1` — Electron `safeStorage`** (`just app`). The blob is the key
   wrapped by safeStorage, whose own AES key sits in the login Keychain under
   the frozen `VAULT_STORE_IDENTITY` (see `vaultKeychain.ts` — the identity
   is a literal, not the app name, for reasons that file explains at length)
   and is ACL-bound to the Electron binary.
3. **`KRAW1` — a 0600 file** (tests, anything with neither). The key itself,
   hex. Hermetic by construction — this is the provider vitest exercises.

`DOMO_VAULT_KEY_PROVIDER=secitem|safestorage|file` forces a provider, for
diagnostics and tests. The Keychain **account** name is the branch-suffixed
instance identity, so two worktree checkouts never share a key.

Three states, kept strictly apart (the distinction is load-bearing — see the
rename incident in DESIGN.md §11a-i): **empty** (no blob — fine, a fresh
vault mints a key on first use), **ok**, and **locked** (a blob exists that
cannot be opened here: safeStorage ciphertext outside Electron, a SecItem
marker without the addon, a garbled blob). Locked is surfaced as locked all
the way to the Vault tab; nothing ever builds a fresh vault over a locked one
(`createKey` refuses while any blob exists, and `LocalVault` refuses items
that exist without a key rather than minting a key that opens nothing).

## The owner's path (`localVault.ts` → the Vault tab)

`LocalVault` is what the `vault:*` IPC handlers in `apps/desktop/src/main.ts`
call. Surface: `list`, `read`, `reveal`, `totp`, `save`, `remove`, plus the
`onReprompt` hook.

- `list` returns summaries — never a secret value. `read` returns the whole
  item with secret fields present-but-null (the form shows the slot; the
  value is fetched one at a time via `reveal`).
- `reveal` decrypts one field because the owner asked to see it on their own
  screen; audited as `SHOWN in app`.
- `totp` derives the current six-digit code from the stored authenticator
  key (`vaultTotp.ts`, RFC 6238 — base32 setup keys and full `otpauth://`
  URIs both parse). `save` refuses a pasted six-digit code where the key
  belongs, while the owner is still looking at the box.
- An item marked **reprompt** stays shut until `onReprompt` answers — in the
  app that is a Touch ID prompt, because this vault has no master password to
  re-ask for.
- `save` enforces: a name; at least one usable site URL on a login (else it
  could never be filled); stale-edit refusal; omitted secret fields keep
  their stored value, a field sent empty is cleared.
- `remove` is final — there is no server-side trash any more.

## The agent's path (`brokerCore.ts` — the credential broker)

The broker is the ONLY way a vault value reaches a page, and it runs
in-process: no subprocess, no port, and the master key never leaves the app's
process. `CredentialBroker` (`credentialBroker.ts`) is the seam the fill path
calls; in production it delegates to `BrokerCore`, and a subprocess mode
survives purely so tests can script a fake broker
(`DOMO_VAULT_BROKER_CMD` → `e2e/fixtures/fakeVaultBroker.cjs`).

Four operations:

- **`status`** — is there a key we can open.
- **`whatsHere(url?)`** — every item, metadata only (id, title, category,
  username, urls, and whether the item's own site is the page on screen —
  advice for the agent, not a filter). Reached by the agent as `plow_vault
  list`; no capability, no approval, audited as `credential_metadata`.
- **`describeItem(id)`** — one item's field *labels*, each with `hidden`
  (does the vault conceal it), `custom`, and `alias` flags. Never values.
  `plow_vault describe`.
- **`getField(id, field, pageUrl)`** — one value, released against the
  device-observed URL of the frame being filled. Only `fill_secret` calls
  this, and it sits behind the rest of the fill gate (approved item set,
  session origin scope, the banking payment approval — see DESIGN.md §11a).

The broker's own rules, applied on top of the session gates:

- **A login belongs to its site.** With a page URL present, a login releases
  only when the page's host and a stored URL's host match by **label
  suffix** (`www.chase.com` ↔ `chase.com`, either direction; no public-suffix
  list, the repo's convention). A login storing *no* site is refused
  outright — "no sites" must never mean "every site". Cards, identities and
  notes are not site-bound by nature and release anywhere (cards are for any
  merchant); the audit line records the page, or `SEM-URL` when no page bound
  the release.
- **One reading answers everything.** The value and its `hidden` flag come
  from a single resolution of the item, so a caller can never act on a stale
  answer to either half. A field without a descriptor is refused, never
  released under a guessed classification.
- **`totp` releases the current code, never the seed** — and is always
  `hidden`, the one place we mask something Bitwarden's own client shows: an
  agent fills a code, it never needs to read one back.

### Classification (`credentialClassify.ts`)

Which fields an item offers, which the vault conceals, and what each label
resolves to — ported line-for-line from the Python broker this replaced. The
rules are Bitwarden's own (a password, card number and CVV, SSN and passport,
Hidden custom fields are concealed; usernames, addresses, expiry are not),
plus the alias table (`cvv` → `code`, `email` → a login's `username`), the
`custom:` prefix that disambiguates a custom field colliding with a built-in
slot, and linked-field resolution (a link resolves to a fixed slot or to
nothing — never through to a custom field). The truth table is
`e2e/fixtures/maskClassification.json`;
`packages/device-core/test/maskClassification.test.ts` drives the real broker
over a real encrypted store against it. What `hidden` means downstream —
masking the value out of screenshots and `forms` after a fill — is
DESIGN.md §11a-ii.

## Migration from the Bitwarden vault (`vaultMigrate.ts`)

Kept in-tree permanently. On the vault's first use, if `items.json` does not
exist and a legacy vault does (`db.sqlite3` + `vault-account.enc`):

1. The old account is read through `VaultSecretStore` (safeStorage under the
   frozen identity — which is why that identity is still frozen).
2. Its password derives the old master key (PBKDF2-SHA256, 600k), which
   unwraps the account's user key from the database.
3. **The new master key := that user key**, so every cipher row is copied
   verbatim — ciphertext is never decrypted, there is no plaintext moment,
   and a crash at any point leaves either the old vault intact and the new
   absent, or both complete (`items.json` is the single atomic write that
   finishes it).
4. The old files stay put as the owner's backup; the new store's existence is
   the migration marker.

A legacy vault whose account cannot be opened reads as **locked** and halts
the migration — it never reads as empty, because empty is what would quietly
mint a fresh vault beside the owner's real one. Soft-deleted rows (the old
trash) are left behind. The database is read via `/usr/bin/sqlite3 -json`
against a temp clone (Electron 33's Node has no `node:sqlite`, and the
originals are never written to).

## Auditing

The audit log is the vault's oracle, in tests and in production:

- Owner actions (`localVault.ts`): `CREATED` / `UPDATED` / `DELETED` /
  `SHOWN in app` / `CODE READ in app`, page recorded as `OWNER`.
- Broker actions (`brokerCore.ts`): `DESCRIBED`, `RELEASED`,
  `DENIED origin mismatch`, `DENIED no site on item`, `ERROR <type>`, against
  the releasing page or `SEM-URL`.
- Device-level events (`credential_metadata`, `credential_filled`,
  `credential_denied`, …) land in `audit.ndjson` via the fill path
  (`browserSessions.ts`).

No line in any of them ever carries a field value.

## Testing

Headless, no Keychain, no Electron: the file key provider is what the suite
runs on. `vaultKeyStore.test.ts` (states and refusals),
`vaultStore` behavior inside `localVault.test.ts` (round-trips all four types,
audit oracle, stale edits, reprompt), `brokerCore.test.ts` (site rules, audit,
locked vault), `vaultMigrate.test.ts` (builds a real legacy SQLite with real
EncStrings and migrates it), `maskClassification.test.ts` (the classification
truth table through the real broker), and the whole fill/masking tier above
the seam (`fillSecretMasking.test.ts` and friends) against the scripted fake
broker. What needs a real machine: the SecItem provider (entitlements only
exist packaged) and the Vault tab itself.
