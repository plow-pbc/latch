#!/usr/bin/env node
/**
 * Fetch the pinned gog binary for both macOS arches into vendor/gog/<arch>/gog.
 *
 * gog ships as a single static Go binary, so unlike the browser runtime there
 * is no source tree and no dependency install: pin, verify, extract. The
 * digest is checked BEFORE extraction — a tarball that does not match the pin
 * is never unpacked, let alone signed into a DMG.
 *
 * The arch directory names are Node's (`arm64`, `x64`), not the release's
 * (`arm64`, `amd64`), because `resolveGogBinary` looks them up by
 * `process.arch` at runtime.
 *
 * ## Bumping the pin — the whole checklist, and its only home
 *
 * Every bump runs through this script, so this is where the version-specific
 * contract lives. `gogFlags.ts`, `registry.ts` and `providers/gogGroups.ts`
 * keep only the invariants their own code depends on and point here.
 *
 *  1. Set `VERSION`, and set all four digests: each arch's `sha256` (the
 *     tarball) and `binary` (what comes out of it). Derive them from the
 *     release, not from a disk — check the tarball against upstream's
 *     `checksums.txt`, then extract and hash.
 *  2. Run this script. It asserts, against the binary it just extracted, that
 *     no gog flag is negatable — the one spelling `gogFlags.ts` cannot see —
 *     and that the extracted bytes match the `binary` pin.
 *  3. Re-run these five BY HAND against the new binary. Each is a spelling
 *     that would disarm a belt flag while matching neither the reserved set
 *     nor either rule, and all five are `unknown flag` at 0.36.0:
 *
 *         gog gmail send … --no-readonly
 *         gog gmail send … --no-wrap-untrusted
 *         gog gmail send … --no-gmail-no-send
 *         gog gmail send … -readonly=false
 *         gog gmail send … -readonly false
 *
 *  4. Re-run the one that proves the gate is load-bearing: appending
 *     `--readonly=false` to an otherwise-refused `gmail send` must be refused
 *     by `gogFlags.ts` before it reaches gog. At 0.36.0, without the gate, it
 *     reached Google.
 *  5. Re-run the scope bound, which the belt now depends on. Against the
 *     darwin binary, with `--enable-commands=gmail,calendar` in front:
 *
 *         gmail|mail|email search q     exit 4 — dispatches (aliases count)
 *         calendar|cal list             exit 4 — dispatches
 *         drive ls, chat spaces list    exit 2 — refused BEFORE any network
 *
 *     And that the bound constrains EXECUTION, not discovery — the shapes
 *     that actually test it are the out-of-scope ones, since in-scope help was
 *     never going to be refused. All exit 0 with full output at 0.36.0:
 *
 *         --help, -h                    top level, still lists every group
 *         drive --help, chat --help     out-of-scope GROUP help still prints
 *         drive ls --help               out-of-scope LEAF help still prints
 *         calendar --help, gmail search -h   in-scope help, for completeness
 *
 *     versus `drive ls`, which is refused. So an agent can read help for a
 *     group it cannot run — the skill says so, because otherwise usage that
 *     prints cleanly reads as a surface that works.
 *
 *     And that appending a second `--enable-commands` still widens it, which
 *     is what `RESERVED_EXACT` exists to refuse. The alias list is gog's to
 *     change, and `GOG_ALIASES` in `providers/gogGroups.ts` mirrors it.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.36.0";
// `sha256` pins the tarball; `binary` pins what comes OUT of it. Both are
// needed and they answer different questions: the tarball pin is what makes a
// download trustworthy, and the binary pin is what makes the CACHE
// trustworthy — a tree that already carries this VERSION is never downloaded
// again, so without it a modified `vendor/gog/<arch>/gog` is copied into the
// app, signed, and handed users' minted Google tokens.
//
// The binary digests are derived from the pinned tarballs, not from whatever
// happened to be on a disk: both tarballs were checked against these pins AND
// against upstream's own `checksums.txt`, then extracted and hashed. Re-derive
// them the same way on a bump — step 1 of the checklist above.
const DIGESTS = {
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
};

// fileURLToPath, not `.pathname`: the latter leaves percent-encoding in place,
// so a checkout under a path with a space resolves to a directory that does not
// exist. Same reason build-browser-runtime.mjs uses it.
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// Skip the fetch when the tree already carries this version, so `just package`
// can depend on this without paying a download every build.
//
// The marker alone is not enough: it attests a VERSION, and the case the
// package dependency exists for is a tree where one arch is missing. So both
// binaries have to be there too, or the skip would be vacuous exactly when it
// matters.
const marker = path.join(root, "vendor/gog/VERSION");

/** The staged binary's path, and whether its bytes are the pinned ones. */
function stagedBinary(arch) {
  const file = path.join(root, "vendor/gog", arch, "gog");
  if (!existsSync(file) || statSync(file).size === 0) return { file, ok: false };
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  return { file, ok: actual === DIGESTS[arch].binary, actual };
}

// CONTENT, not existence. Existence plus a size matched afterPack's gate and
// nothing else: a cached binary that had been modified — by anything with
// write access to the checkout — carried the current marker, skipped the
// fetch, and went on to be signed and to receive minted Google tokens. Size
// alone still matters for the case this skip exists for, a tree where one arch
// is missing, and the hash subsumes it.
const staged = Object.keys(DIGESTS).every((arch) => stagedBinary(arch).ok);
if (staged && existsSync(marker) && readFileSync(marker, "utf8").trim() === VERSION) {
  console.log(`vendor/gog is already at ${VERSION}`);
  process.exit(0);
}
const staging = mkdtempSync(path.join(tmpdir(), "gog-fetch-"));

try {
  for (const [arch, { asset, sha256 }] of Object.entries(DIGESTS)) {
    const name = `gogcli_${VERSION}_${asset}.tar.gz`;
    const url = `https://github.com/openclaw/gogcli/releases/download/v${VERSION}/${name}`;
    const tarball = path.join(staging, name);
    console.log(`fetching ${name}`);
    execFileSync("curl", ["-sSL", "--fail", "-o", tarball, url], { stdio: "inherit" });

    const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    if (actual !== sha256) {
      throw new Error(`${name}: sha256 ${actual} does not match the pin ${sha256}`);
    }

    const dest = path.join(root, "vendor/gog", arch);
    mkdirSync(dest, { recursive: true });
    execFileSync("tar", ["xzf", tarball, "-C", dest, "gog"], { stdio: "inherit" });
    // The same check the skip makes, at the one moment the alternative is
    // knowable: a tarball whose digest is right but whose contents are not
    // what this pin was derived from fails HERE rather than being cached and
    // then trusted forever after by the skip above.
    const extracted = stagedBinary(arch);
    if (!extracted.ok) {
      throw new Error(
        `${extracted.file}: sha256 ${extracted.actual ?? "(missing)"} does not match the pinned ` +
          `binary ${DIGESTS[arch].binary}`,
      );
    }
    console.log(`  verified and extracted → vendor/gog/${arch}/gog`);
  }
  // The safety-flag assertion, at the one moment the binary is in hand.
  //
  // gogFlags.ts refuses a closed set of spellings; kong can mint a SECOND
  // long spelling for a boolean flag, `--no-<name>`, which would disarm a belt
  // flag while matching neither the set nor either rule. Zero flags are
  // negatable at 0.36.0 — asserted here so a pin bump fails the fetch rather
  // than shipping a binary whose grammar the gate cannot see.
  // THIS host's arch. Picking by digest-key order would hand an Intel Mac the
  // arm64 binary and die with `Bad CPU type in executable` — Rosetta
  // translates x86 to arm, not the reverse — so the guard would hard-fail the
  // fetch, and `just package` with it, on a supported build host for a pin
  // that is perfectly good. The keys are deliberately Node's names.
  const arch = process.arch;
  const binary = path.join(root, "vendor/gog", arch, "gog");
  // Reachable only on an unsupported host ARCH: both DIGESTS arches were
  // extracted above and `tar` would have thrown otherwise. A non-darwin host
  // of a supported arch gets past this and fails later, at exec.
  if (!existsSync(binary)) {
    throw new Error(`no pinned gog for ${arch} — this script fetches darwin arm64/x64 only`);
  }
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
  // A floor, because the check above is worthless if it never saw a flag.
  //
  // THIS COMMENT IS THE ONLY ACCOUNT OF WHAT THE GUARD COVERS. gogFlags.ts
  // points here rather than restating it — two files each carrying a full
  // account is what produced four rounds of one drifting out of step with the
  // other, every fix to one making the other the outlier.
  //
  // Covers: a renamed `flags` or `subcommands` key. Either drops the count far
  // below the floor (this walk re-counts globals under every subcommand, so it
  // sees ~17k at 0.36.0), so the fetch fails instead of certifying zero
  // negatable flags from a key nothing reads.
  //
  // Does NOT cover: a renamed `negated` key. The count stays intact and
  // `negatable` stays empty. Only step 3's hand probes in this file's header
  // bear on that, which is why they are not optional on a bump.
  if (flagsSeen < 500) {
    throw new Error(`only ${flagsSeen} flags parsed from gog's schema — has its shape changed?`);
  }
  if (negatable.length > 0) {
    throw new Error(
      `negatable flags found, which gogFlags.ts cannot see: ${negatable.join(", ")}. ` +
        `Canonicalise --no-X to --X there before bumping the pin.`,
    );
  }
  console.log(`${flagsSeen} flags checked, none negatable`);

  // Record what is on disk so a stale tree is legible without re-hashing.
  writeFileSync(path.join(root, "vendor/gog/VERSION"), `${VERSION}\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
