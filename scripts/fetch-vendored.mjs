#!/usr/bin/env node
/**
 * Stage a pinned vendored CLI into `vendor/<command>/<arch>/<command>`.
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
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VENDORED, providerNamed } from "./vendored-providers.mjs";

// fileURLToPath, not `.pathname`: the latter leaves percent-encoding in place,
// so a checkout under a path with a space resolves to a directory that does not
// exist. Same reason build-browser-runtime.mjs uses it.
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The staged binary's path, and whether its bytes are the pinned ones. */
export function stagedBinary(provider, arch, root) {
  const file = path.join(root, "vendor", provider.command, arch, provider.command);
  if (!existsSync(file)) return { file, ok: false };
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  return { file, ok: actual === provider.arches[arch].binary, actual };
}

/**
 * Whether the tree already carries this pin, so `package` can depend on the
 * fetch without paying a download every build.
 *
 * CONTENT, not existence. Existence plus a size matched afterPack's gate and
 * nothing else: a cached binary modified by anything with write access to the
 * checkout carried the current marker, skipped the fetch, and went on to be
 * signed and to receive minted tokens. The hash subsumes the size check, and
 * covers the case the skip exists for — a tree where one arch is missing.
 *
 * The marker alone is not enough either: it attests a version, not any bytes.
 */
export function isStaged(provider, root) {
  const marker = path.join(root, "vendor", provider.command, "VERSION");
  if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== provider.version) return false;
  return Object.keys(provider.arches).every((arch) => stagedBinary(provider, arch, root).ok);
}

function fetchProvider(provider) {
  const { command, version } = provider;
  if (isStaged(provider, repoRoot)) {
    console.log(`vendor/${command} is already at ${version}`);
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

      const dest = path.join(repoRoot, "vendor", command, arch);
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
      console.log(`  verified and extracted → vendor/${command}/${arch}/${command}`);
    }
    // The provider's own safety assertion, at the one moment its binary is in
    // hand. What each one covers is written on its row.
    console.log(`  ${provider.probe(stagedBinary(provider, process.arch, repoRoot).file)}`);

    // Record what is on disk so a stale tree is legible without re-hashing.
    writeFileSync(path.join(repoRoot, "vendor", command, "VERSION"), `${version}\n`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// Only when run as a script, so a test can import the predicate above without
// the CLI firing on import.
//
// REALPATHS, both sides. Node resolves symlinks when it computes a module's URL
// but not when it sets argv[1], so through any symlinked path component — a
// checkout under /tmp on macOS, a symlinked home — the two differ, this block
// never runs, and the script exits 0 having fetched nothing. `_package` reads
// that as a successful fetch and pays the whole browser build before afterPack
// fails on a missing extraResources source.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  const wanted = arg === "--all" ? VENDORED : [providerNamed(arg)];
  if (!arg || wanted[0] == null) {
    const names = VENDORED.map((p) => p.command).join("|");
    console.error(`usage: fetch-vendored.mjs <${names}|--all>`);
    process.exit(2);
  }
  for (const provider of wanted) fetchProvider(provider);
}
