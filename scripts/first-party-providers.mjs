/**
 * The provider CLIs this repo BUILDS, as opposed to the ones it fetches.
 *
 * Two build-time sources stage a payload into `vendor/providers/`, and they
 * are different in kind:
 *
 *  - `vendored-providers.mjs` — third-party CLIs downloaded from a release and
 *    verified against a pinned sha256. `gog` is the one today.
 *  - this list — first-party CLIs compiled from source in `apps/desktop/native`
 *    by `build-native.mjs`. They have no URL and no pin, because their source
 *    is right here and the commit IS the version.
 *
 * Both halves resolve identically at runtime (`resolveVendoredBinary` looks
 * only at `vendor/providers/<command>/<arch>/<command>`), so the distinction
 * exists only at build time. It is nonetheless load-bearing for one test:
 * `registry.test.ts` asserts that every binary a `PROVIDERS` row names is
 * actually staged by SOMETHING, and the failure it catches — a provider added
 * to the registry and to neither build side, which ships a skill for a binary
 * that is not there — needs both lists to check against.
 *
 * Not TypeScript, and for `vendored-providers.mjs`'s reason: a manifest that
 * needs a build step to be read is a cycle, and `build-native.mjs` runs before
 * anything is built.
 */

/**
 * `command` is the ONE spelling, exactly as on the vendored side: argv[0], the
 * directory under `vendor/providers/`, the binary inside it, and the row in
 * `PROVIDERS`. `source` and `bridge` are relative to `apps/desktop/native`.
 */
const PLOW_MESSAGES = {
  command: "plow-messages",
  source: "plow-messages.swift",
  // The ObjC `@try` around NSUnarchiver. A build INPUT, not just a header:
  // the compile stamp hashes it, so editing the shim rebuilds the binary.
  bridge: "plow-messages-bridge.h",
  // macOS 13, like every other Swift helper here. Nothing in the CLI uses a
  // newer API; Foundation's typedstream decoder long predates it.
  target: "macos13.0",
};

export const FIRST_PARTY = [PLOW_MESSAGES];
