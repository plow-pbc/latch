/**
 * The vendored CLIs `fetch-vendored.mjs` stages, and what each one is pinned to.
 *
 * Build-time only, and deliberately NOT TypeScript: `just fetch-vendored` has
 * no build step, and a manifest that needs one to be read is a cycle. Not JSON
 * either, because two facts per provider are code — the release URL, whose
 * asset naming is the upstream project's business, and the post-extraction
 * safety probe.
 *
 * `command` is the ONE spelling: argv[0], the vendor directory, the binary
 * inside it, the member extracted from the release tarball, and the row in
 * `PROVIDERS`. A release naming its binary anything else — `bin/foo`,
 * `foocli` — is unrepresentable, because tar preserves interior paths and
 * `resolveVendoredBinary` only ever looks at `vendor/<command>/<arch>/<command>`.
 * `registry.test.ts` asserts the two lists agree, because they live in
 * different halves of the repo.
 */
import { execFileSync } from "node:child_process";

/**
 * Bumping gog's pin — the whole checklist, and its only home.
 *
 * Per-version verdicts about gog's own grammar. They live on gog's row rather
 * than in the fetcher, which knows nothing about any particular CLI.
 *
 *  1. Set `version`, and set all four digests: each arch's `sha256` (the
 *     tarball) and `binary` (what comes out of it). Derive them from the
 *     release, not from a disk — check the tarball against upstream's
 *     `checksums.txt`, then extract and hash.
 *  2. Run `just fetch-vendored gog`. It asserts, against the binary it just
 *     extracted, that no gog flag is negatable — the one spelling
 *     `gogFlags.ts` cannot see — and that the extracted bytes match `binary`.
 *  3. Re-run these six BY HAND against the new binary. The first five are
 *     spellings that would disarm a belt flag while matching neither the
 *     reserved set nor either rule; all five are `unknown flag` at 0.36.0:
 *
 *         gog gmail send … --no-readonly
 *         gog gmail send … --no-wrap-untrusted
 *         gog gmail send … --no-gmail-no-send
 *         gog gmail send … -readonly=false
 *         gog gmail send … -readonly false
 *
 *     The sixth is not a disarming spelling but the verdict the help allowance
 *     RESTS on — `expected string value` at 0.36.0:
 *
 *         gog gmail send --to x@y --subject --help
 *
 *     `isHelpInvocation` accepts that shape, so `refuse` returns null with no
 *     group check and nothing is minted. If a bump ever made kong take `--help`
 *     there as a literal subject, a `gmail send` would run unrefused. Nothing
 *     else on this list would catch it, which is why it is on this list.
 *
 *  4. Re-run the one that proves the gate is load-bearing: appending
 *     `--readonly=false` to an otherwise-refused `gmail send` must be refused
 *     by `gogFlags.ts` before it reaches gog. At 0.36.0, without the gate, it
 *     reached Google.
 *  5. Re-run the scope bound, which the belt depends on. Against the darwin
 *     binary, with `--enable-commands=gmail,calendar` in front:
 *
 *         gmail|mail|email search q     exit 4 — dispatches (aliases count)
 *         calendar|cal list             exit 4 — dispatches
 *         drive ls, chat spaces list    exit 2 — refused BEFORE any network
 *
 *     And that the bound constrains EXECUTION, not discovery — the shapes that
 *     test it are the out-of-scope ones. All exit 0 with full output at 0.36.0:
 *     `--help`, `-h`, `drive --help`, `chat --help`, `drive ls --help`,
 *     `calendar --help`, `gmail search -h`. Versus `drive ls`, which is
 *     refused. So an agent can read help for a group it cannot run — the skill
 *     says so, because usage that prints cleanly otherwise reads as a surface
 *     that works.
 *
 *     And that appending a second `--enable-commands` still widens it, which is
 *     what `RESERVED_EXACT` exists to refuse. The alias list is gog's to
 *     change, and `GOG_ALIASES` in `gogGroups.ts` mirrors it.
 */
const GOG = {
  command: "gog",
  version: "0.36.0",
  // Keys are Node's `process.arch` names, not the release's (`amd64`). They are
  // the one spelling in three places: the directory the fetcher stages into,
  // the directory `resolveVendoredBinary` reads at runtime, and the directory
  // inside the packed app that afterPack's gate requires for every key here.
  //
  // `sha256` pins the tarball; `binary` pins what comes OUT of it. Both are
  // needed and they answer different questions: the tarball pin makes a
  // DOWNLOAD trustworthy, the binary pin makes the CACHE trustworthy — a tree
  // already carrying this version is never downloaded again, so without it a
  // modified `vendor/providers/gog/<arch>/gog` is copied into the app, signed, and handed
  // users' minted Google tokens.
  arches: {
    arm64: {
      asset: "darwin_arm64",
      sha256: "5cb5b5210879769bc6a02bd9cf39ed1b0de3f0713b397ecbddefe95dd2be618b",
      binary: "61e973aa213d972a5af22cc89f5bd3a47974063cbec7343463101858373b3a5e",
    },
    x64: {
      asset: "darwin_amd64",
      sha256: "7252cfc0a63d239912d0d57ca5f51e31ca58472b506834237e148704387902df",
      binary: "a5a1b2715d60c1112f0c06f79b919fe7cf58c9431e3fab27d50dd5d11be15ac8",
    },
  },
  url: (version, asset) =>
    `https://github.com/openclaw/gogcli/releases/download/v${version}/gogcli_${version}_${asset}.tar.gz`,
  probe: gogNoNegatableFlags,
};

/**
 * gog's post-extraction safety assertion, run against the binary in hand.
 *
 * `gogFlags.ts` refuses a closed set of spellings; kong can mint a SECOND long
 * spelling for a boolean flag, `--no-<name>`, which would disarm a belt flag
 * while matching neither the set nor either rule. Zero flags are negatable at
 * 0.36.0 — asserted here so a pin bump fails the fetch rather than shipping a
 * binary whose grammar the gate cannot see.
 *
 * THIS COMMENT IS THE ONLY ACCOUNT OF WHAT THE GUARD COVERS. `gogFlags.ts`
 * points here rather than restating it.
 *
 * Covers: a renamed `flags` or `subcommands` key. Either drops the count far
 * below the floor (this walk re-counts globals under every subcommand, so it
 * sees ~17k at 0.36.0), so the fetch fails instead of certifying zero negatable
 * flags from a key nothing reads.
 *
 * Does NOT cover: a renamed `negated` key — the count stays intact and the list
 * stays empty. Only step 3's hand probes bear on that, which is why they are
 * not optional on a bump.
 */
function gogNoNegatableFlags(binary) {
  const schema = JSON.parse(
    execFileSync(binary, ["--no-input", "schema", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const negatable = [];
  let flagsSeen = 0;
  const walk = (node) => {
    for (const f of node.flags ?? []) {
      flagsSeen++;
      if (f.negated) negatable.push(f.name);
    }
    for (const sub of node.subcommands ?? []) walk(sub);
  };
  walk(schema.command ?? {});
  if (flagsSeen < 500) {
    throw new Error(`only ${flagsSeen} flags parsed from gog's schema — has its shape changed?`);
  }
  if (negatable.length > 0) {
    throw new Error(
      `negatable flags found, which gogFlags.ts cannot see: ${negatable.join(", ")}. ` +
        `Canonicalise --no-X to --X there before bumping the pin.`,
    );
  }
  return `${flagsSeen} flags checked, none negatable`;
}

export const VENDORED = [GOG];

/** The row for a command, or null. */
export function providerNamed(command) {
  return VENDORED.find((p) => p.command === command) ?? null;
}
