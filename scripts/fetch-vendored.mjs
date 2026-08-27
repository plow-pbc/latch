#!/usr/bin/env node
/**
 * Stage a pinned vendored CLI into `vendor/providers/<command>/<arch>/<command>`.
 *
 * These ship as single static binaries, so unlike the browser runtime there is
 * no source tree and no dependency install: pin, verify, extract. The digest is
 * checked BEFORE extraction — a tarball that does not match its pin is never
 * unpacked, let alone signed into a DMG.
 *
 * What is pinned, and gog's per-version bump checklist, are in
 * `vendored-providers.mjs`. This file knows nothing about any particular CLI.
 *
 *     node scripts/fetch-vendored.mjs gog     one provider
 *     node scripts/fetch-vendored.mjs --all   every provider (what `package` runs)
 *
 * **Exports nothing, and nothing may import it.** The CLI below runs at module
 * scope, so an import fires it — downloading tarballs, writing into `vendor/`,
 * or exiting 2 mid-import. That is the trade for having no run-only-if-invoked
 * guard, which is what a symlinked checkout once turned into a silent no-op.
 * The staging predicates live in `vendored-staging.mjs` for exactly this
 * reason; anything else worth sharing goes there too, not here.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VENDORED, providerNamed } from "./vendored-providers.mjs";
import { MARKER, PROVIDER_ROOT, isStaged, stagedBinary } from "./vendored-staging.mjs";

// fileURLToPath, not `.pathname`: the latter leaves percent-encoding in place,
// so a checkout under a path with a space resolves to a directory that does not
// exist. Same reason build-browser-runtime.mjs uses it.
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function fetchProvider(provider) {
  const { command, version } = provider;
  if (isStaged(provider, repoRoot)) {
    console.log(`vendor/${PROVIDER_ROOT}/${command} is already at ${version}`);
    return;
  }
  // THIS host's arch has to be one of the pinned ones, because the probe below
  // runs the binary. Picking one by key order instead would hand an Intel Mac
  // the arm64 binary and die with `Bad CPU type in executable` — Rosetta
  // translates x86 to arm, not the reverse — failing the fetch, and
  // `just package` with it, on a supported build host for a perfectly good pin.
  if (!provider.arches[process.arch]) {
    throw new Error(
      `no pinned ${command} for ${process.arch} — this fetches darwin ` +
        `${Object.keys(provider.arches).join("/")} only`,
    );
  }
  const staging = mkdtempSync(path.join(tmpdir(), `${command}-fetch-`));
  try {
    for (const [arch, { asset, sha256 }] of Object.entries(provider.arches)) {
      const url = provider.url(version, asset);
      const tarball = path.join(staging, path.basename(new URL(url).pathname));
      console.log(`fetching ${command} ${version} ${asset}`);
      execFileSync("curl", ["-sSL", "--fail", "-o", tarball, url], { stdio: "inherit" });

      const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
      if (actual !== sha256) {
        throw new Error(`${command} ${asset}: sha256 ${actual} does not match the pin ${sha256}`);
      }

      const dest = path.join(repoRoot, "vendor", PROVIDER_ROOT, command, arch);
      mkdirSync(dest, { recursive: true });
      execFileSync("tar", ["xzf", tarball, "-C", dest, command], { stdio: "inherit" });
      // The same check the skip makes, at the one moment the alternative is
      // knowable: a tarball whose digest is right but whose contents are not
      // what this pin was derived from fails HERE, rather than being cached and
      // then trusted forever after by the skip.
      const extracted = stagedBinary(provider, arch, repoRoot);
      if (!extracted.ok) {
        throw new Error(
          `${extracted.file}: sha256 ${extracted.actual ?? "(missing)"} does not match the ` +
            `pinned binary ${provider.arches[arch].binary}`,
        );
      }
      console.log(`  verified and extracted → vendor/${PROVIDER_ROOT}/${command}/${arch}/${command}`);
    }
    // The provider's own safety assertion, at the one moment its binary is in
    // hand. What each one covers is written on its row.
    console.log(`  ${provider.probe(stagedBinary(provider, process.arch, repoRoot).file)}`);

    // Record what is on disk so a stale tree is legible without re-hashing.
    writeFileSync(path.join(repoRoot, "vendor", PROVIDER_ROOT, command, MARKER), `${version}\n`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const arg = process.argv[2];
const wanted = arg === "--all" ? VENDORED : [providerNamed(arg)];
if (!arg || wanted[0] == null) {
  const names = VENDORED.map((p) => p.command).join("|");
  console.error(`usage: fetch-vendored.mjs <${names}|--all>`);
  process.exit(2);
}
for (const provider of wanted) fetchProvider(provider);
