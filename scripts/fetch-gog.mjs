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
 * Bump `VERSION` and both digests together. This script then asserts, against
 * the binary it just extracted, that no gog flag is negatable — the one
 * spelling `reservedFlags.ts` cannot see. The `--readonly` behaviour recorded
 * in that file is verified per version and is a HAND probe: re-run it on a
 * bump.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.36.0";
const DIGESTS = {
  arm64: { asset: "darwin_arm64", sha256: "5cb5b5210879769bc6a02bd9cf39ed1b0de3f0713b397ecbddefe95dd2be618b" },
  x64: { asset: "darwin_amd64", sha256: "7252cfc0a63d239912d0d57ca5f51e31ca58472b506834237e148704387902df" },
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
// A file WITH A SIZE, matching afterPack's gate exactly — otherwise a
// zero-byte binary satisfies the fetch's skip and then fails the package,
// which is the disagreement that makes a skip vacuous.
const staged = Object.keys(DIGESTS).every((arch) => {
  const binary = path.join(root, "vendor/gog", arch, "gog");
  return existsSync(binary) && statSync(binary).size > 0;
});
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
    console.log(`  verified and extracted → vendor/gog/${arch}/gog`);
  }
  // The safety-flag assertion, at the one moment the binary is in hand.
  //
  // reservedFlags.ts refuses a closed set of spellings; kong can mint a SECOND
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
  if (!existsSync(binary)) throw new Error(`no gog for ${arch} at ${binary} — extraction failed?`);
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
  // A floor, because the check is worthless if it never saw a flag: a renamed
  // schema key would otherwise certify zero negatable flags from a key nothing
  // reads. This walk counts globals again under every subcommand, so it sees
  // ~17k at 0.36.0 — far above the floor, which is set low deliberately: it is
  // a did-we-parse-anything check, not a did-the-surface-change one.
  if (flagsSeen < 500) {
    throw new Error(`only ${flagsSeen} flags parsed from gog's schema — has its shape changed?`);
  }
  if (negatable.length > 0) {
    throw new Error(
      `negatable flags found, which reservedFlags.ts cannot see: ${negatable.join(", ")}. ` +
        `Canonicalise --no-X to --X there before bumping the pin.`,
    );
  }
  console.log(`${flagsSeen} flags checked, none negatable`);

  // Record what is on disk so a stale tree is legible without re-hashing, and
  // so the skill can name the version without a second hard-coded copy.
  writeFileSync(path.join(root, "vendor/gog/VERSION"), `${VERSION}\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
