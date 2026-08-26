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
 * Bump `VERSION` and both digests together; then regenerate the leaf list
 * (`scripts/fetch-gog-schema.mjs`) and re-run the four --readonly checks the
 * design spec records, because that guard is verified per version.
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
  // Record what is on disk so a stale tree is legible without re-hashing.
  writeFileSync(path.join(root, "vendor/gog/VERSION"), `${VERSION}\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
