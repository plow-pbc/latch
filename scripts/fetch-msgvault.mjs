#!/usr/bin/env node
/**
 * Fetches the msgvault CLI into gitignored vendor/msgvault/<arch>/msgvault,
 * hash-pinned by vendor/msgvault.lock.json. Same shape as the vault-cli
 * payload in build-browser-runtime.mjs: per-arch trees (single Go binary,
 * nobody has fused one), a .sha256 marker for caching, ad-hoc signature in
 * dev, Developer ID + helper entitlements when CODESIGN_IDENTITY is set.
 *
 *   node scripts/fetch-msgvault.mjs          # host arch
 *   node scripts/fetch-msgvault.mjs --both   # arm64 + x86_64 (packaging)
 *
 * The upstream LICENSE (MIT) ships beside the binaries so the packaged app
 * carries the attribution redistribution requires.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const vendorDir = path.join(repoRoot, "vendor");
const msgvaultDir = path.join(vendorDir, "msgvault");
const downloadsDir = path.join(vendorDir, "downloads");
const lock = JSON.parse(fs.readFileSync(path.join(vendorDir, "msgvault.lock.json"), "utf8")).msgvault;

const wantBoth = process.argv.includes("--both");

function log(msg) {
  process.stdout.write(`[msgvault] ${msg}\n`);
}

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${argv.join(" ")} failed (exit ${r.status})\n${r.stdout}\n${r.stderr}`);
  }
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function download(url, expectedSha, dest) {
  if (fs.existsSync(dest) && sha256(dest) === expectedSha) {
    log(`cached: ${path.basename(dest)}`);
    return;
  }
  log(`downloading ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  run("curl", ["-fsSL", "-o", dest + ".part", url]);
  const got = sha256(dest + ".part");
  if (got !== expectedSha) {
    fs.rmSync(dest + ".part", { force: true });
    throw new Error(`sha256 mismatch for ${url}\n  expected ${expectedSha}\n  got      ${got}`);
  }
  fs.renameSync(dest + ".part", dest);
}

function fetchMsgvault(arch) {
  const asset = lock.assets[arch === "arm64" ? "arm64" : "x64"];
  const installRoot = path.join(msgvaultDir, arch);
  const marker = path.join(installRoot, ".sha256");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === asset.sha256) {
    log(`msgvault ${arch} up to date`);
    return;
  }
  const tarDest = path.join(downloadsDir, path.basename(new URL(asset.url).pathname));
  download(asset.url, asset.sha256, tarDest);
  log(`extracting msgvault (${arch})`);
  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.mkdirSync(installRoot, { recursive: true });
  run("tar", ["-xzf", tarDest, "-C", installRoot]);
  const bin = path.join(installRoot, "msgvault");
  if (!fs.existsSync(bin)) throw new Error(`no msgvault binary in ${asset.url}`);
  fs.chmodSync(bin, 0o755); // release tarballs are built on CI; don't trust mode bits
  // Ad-hoc so a dev-fetched arm64 binary runs at all (arm64 kills invalid
  // signatures); `just package` replaces this with the Developer ID below.
  run("codesign", ["--force", "--sign", "-", bin]);
  fs.writeFileSync(marker, asset.sha256);
  log(`msgvault ${arch} ready at ${installRoot}`);
}

function fetchLicense() {
  const dest = path.join(msgvaultDir, "LICENSE");
  if (fs.existsSync(dest) && sha256(dest) === lock.license.sha256) return;
  download(lock.license.url, lock.license.sha256, dest);
  log("LICENSE ready");
}

/** Developer ID + helper entitlements, matching the other bundled binaries. */
function signMsgvault(arch, identity) {
  const bin = path.join(msgvaultDir, arch, "msgvault");
  if (!fs.existsSync(bin)) return;
  const entitlements = path.join(repoRoot, "apps/desktop/build/entitlements.helper.plist");
  run("codesign", [
    "--force", "--timestamp", "--options", "runtime",
    "--entitlements", entitlements, "--sign", identity, bin,
  ]);
  log(`signed msgvault (${arch}) with Developer ID`);
}

try {
  const hostArch = process.arch === "arm64" ? "arm64" : "x86_64";
  const arches = wantBoth ? ["arm64", "x86_64"] : [hostArch];
  fs.mkdirSync(msgvaultDir, { recursive: true });
  fetchLicense();
  for (const a of arches) fetchMsgvault(a);
  const identity = process.env.CODESIGN_IDENTITY;
  if (identity) {
    for (const a of arches) signMsgvault(a, identity);
  } else {
    log("CODESIGN_IDENTITY not set — keeping ad-hoc signatures (dev mode)");
  }
} catch (error) {
  process.stderr.write(`\n[msgvault] FAILED: ${error.message}\n`);
  process.exit(1);
}
