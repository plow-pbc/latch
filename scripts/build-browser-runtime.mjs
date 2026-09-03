#!/usr/bin/env node
/**
 * Fetches the Camoufox browser and freezes a fingerprint pool for the browser
 * stack into gitignored vendor/ dirs, deterministically and cached. No Python
 * ships: the runtime is @domo/browser-server (playwright-core) and the disguise
 * comes from a build-time pool (DESIGN.md §11a).
 *
 *   vendor/camoufox-browser/<arch>/Camoufox.app   (--browser: this arch only)
 *   vendor/camoufox-browser/universal/            (--browser-both: both arches
 *                                                  lipo-fused into one tree —
 *                                                  what `just package` bundles)
 *   packages/browser-server/fingerprints.json     the frozen macOS config pool,
 *                                                  sampled here via camoufox-js
 *                                                  (a build-only dependency)
 *
 * Sources and pins live in vendor/browser-server/runtime.lock.json. Downloads
 * are cached in vendor/downloads/; a per-arch .sha256 marker makes re-runs
 * no-ops until the pins change.
 *
 * Signing: binaries modified here (install_name_tool) are re-signed AD-HOC so
 * they run locally (arm64 kills invalid signatures). `just package` re-signs
 * everything with the Developer ID via CODESIGN_IDENTITY.
 */
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const vendorDir = path.join(repoRoot, "vendor");
const serverDir = path.join(vendorDir, "browser-server");
const downloadsDir = path.join(vendorDir, "downloads");
const browserDir = path.join(vendorDir, "camoufox-browser");

const lock = JSON.parse(fs.readFileSync(path.join(serverDir, "runtime.lock.json"), "utf8"));

// camoufox-js (the fingerprint sampler below) pulls in better-sqlite3 13.x,
// which has no Node 20 build: on Node 20 it segfaults at load (signal 11) with
// no message, which is how a release run died once. Fail here, with words.
const MIN_NODE_MAJOR = 22;
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < MIN_NODE_MAJOR) {
  process.stderr.write(
    `[browser-runtime] Node ${process.versions.node} is too old: the fingerprint pool ` +
      `needs Node ${MIN_NODE_MAJOR}+ (better-sqlite3 ships no build for older Node).\n`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const wantBrowser = args.includes("--browser") || args.includes("--browser-both");
const wantBoth = args.includes("--browser-both");

// Bump when the pruning/merging logic below changes, so cached trees (which
// are keyed on the download pins) rebuild with the new slimming applied. Two
// incompatible v3 trees exist: main's driver-pruned tree still bundled UBO,
// while the branch's v3 removed UBO without the driver pruning. v4 identifies
// the tree that applies both changes so neither v3 cache can be reused.
const PRUNE_VERSION = "4";

function log(msg) {
  process.stdout.write(`[browser-runtime] ${msg}\n`);
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: opts.quiet ? "pipe" : "inherit", ...opts });
  if (r.status !== 0) {
    const detail = opts.quiet ? `\n${r.stdout}\n${r.stderr}` : "";
    throw new Error(`${cmd} ${argv.join(" ")} failed (exit ${r.status})${detail}`);
  }
  return r;
}

function capture(cmd, argv) {
  return execFileSync(cmd, argv, { encoding: "utf8" });
}

function sha256(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
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

function* machOFiles(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      yield* machOFiles(p);
    } else if (entry.isFile()) {
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      const magic = buf.readUInt32BE(0);
      // Mach-O (64-bit both endians) or fat/universal.
      if ([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) yield p;
    }
  }
}

function adhocSign(file) {
  run("codesign", ["--force", "--sign", "-", file], { quiet: true });
}



/**
 * Mark an app bundle LSUIElement so LaunchServices never gives it a Dock tile.
 * Idempotent and not gated by the build cache, so already-built trees get
 * patched without a rebuild. `resign` re-seals the bundle ad-hoc afterward:
 * needed when the bundle shipped with a real bundle signature (its code
 * directory seals the Info.plist, and arm64 kills invalid signatures), and
 * wrong when it didn't — Camoufox ships linker-signed/unsigned, carries no
 * plist seal to break, and its unsigned x86_64 dylibs make a bundle re-sign
 * impossible anyway. The re-sign only happens on first patch, so a Developer
 * ID signature is never clobbered.
 */
function patchDockPolicy(appBundle, { resign }) {
  const plist = path.join(appBundle, "Contents", "Info.plist");
  if (!fs.existsSync(plist)) return;
  const probe = spawnSync("plutil", ["-extract", "LSUIElement", "raw", "-o", "-", plist]);
  if (probe.status === 0 && probe.stdout.toString().trim() === "true") return;
  log(`patching ${path.basename(appBundle)} Info.plist (LSUIElement) to keep it out of the Dock`);
  run("plutil", ["-replace", "LSUIElement", "-bool", "true", plist], { quiet: true });
  if (resign) run("codesign", ["--force", "--sign", "-", appBundle], { quiet: true });
}


/**
 * Keep Camoufox out of the Dock. Even headless, Firefox launches with a
 * regular activation policy for the first ~20ms before Gecko's headless
 * startup demotes it to prohibited — and the Dock animates a tile in and back
 * out, turning those milliseconds into a visible icon flash every time a
 * browsing session starts. LSUIElement makes the initial registration
 * accessory, so no tile ever appears. A `--headed` debug run still shows its
 * window; it just never occupies the Dock. Patches every install dir present
 * (arm64 / x86_64 / universal), whether built this run or earlier.
 */
function patchCamoufoxDockPolicies() {
  if (!fs.existsSync(browserDir)) return;
  for (const arch of fs.readdirSync(browserDir)) {
    const official = path.join(browserDir, arch, "browsers");
    if (!fs.existsSync(official)) continue;
    for (const repo of fs.readdirSync(official)) {
      const repoDir = path.join(official, repo);
      if (!fs.statSync(repoDir).isDirectory()) continue;
      for (const folder of fs.readdirSync(repoDir)) {
        patchDockPolicy(path.join(repoDir, folder, "Camoufox.app"), { resign: false });
      }
    }
  }
}


// ---------------------------------------------------------------------------
// Camoufox browser payload
// ---------------------------------------------------------------------------
/**
 * Builds a complete camoufox INSTALL DIR (the layout `camoufox fetch` creates
 * under ~/Library/Caches/camoufox) so the runtime finds a ready install when
 * BrowserHost points the server's $HOME at an app-scoped dir:
 *
 *   <arch>/.0.5_FLAG
 *   <arch>/config.json                      {"active_version": "browsers/official/<folder>"}
 *   <arch>/browsers/official/<folder>/      zip contents + version.json
 */
function fetchBrowser(arch) {
  const asset = lock.camoufox.assets[arch === "arm64" ? "arm64" : "x64"];
  const installRoot = path.join(browserDir, arch);
  const marker = path.join(installRoot, ".sha256");
  const markerValue = `${asset.sha256}:${PRUNE_VERSION}`;
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === markerValue) {
    log(`camoufox ${arch} up to date`);
    return;
  }
  const [repo, fullVersion] = lock.camoufox.browserVersion.split("/");
  const dash = fullVersion.indexOf("-");
  const version = dash === -1 ? fullVersion : fullVersion.slice(0, dash);
  const build = dash === -1 ? "" : fullVersion.slice(dash + 1);
  const folder = `${fullVersion}-${asset.sha256.slice(0, 8)}`;
  const installPath = path.join(installRoot, "browsers", repo, folder);

  const zipDest = path.join(downloadsDir, path.basename(new URL(asset.url).pathname));
  download(asset.url, asset.sha256, zipDest);
  log(`extracting camoufox (${arch})`);
  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.mkdirSync(installPath, { recursive: true });
  run("ditto", ["-x", "-k", zipDest, installPath]); // preserves symlinks + exec bits

  // Camoufox bundles ~360 MB of Windows/Linux fonts so a spoofed non-mac
  // fingerprint can actually render its claimed fonts. The pool below samples
  // only macOS fingerprints (os: "macos"), which render with the system fonts
  // (camoufox's fonts.json mac list is entirely macOS-shipped families), so the
  // bundle is dead weight. Fail loudly if the layout ever moves.
  const fontsDir = path.join(installPath, "Camoufox.app", "Contents", "Resources", "fonts");
  if (!fs.existsSync(fontsDir)) {
    throw new Error(`expected bundled fonts at ${fontsDir} — did the zip layout change?`);
  }
  fs.rmSync(fontsDir, { recursive: true });

  fs.writeFileSync(
    path.join(installPath, "version.json"),
    JSON.stringify({ version, build, prerelease: true, sha256: asset.sha256 }),
  );
  fs.writeFileSync(
    path.join(installRoot, "config.json"),
    JSON.stringify({ active_version: `browsers/${repo}/${folder}` }),
  );
  fs.writeFileSync(path.join(installRoot, ".0.5_FLAG"), "");

  // No addon is bundled. The frozen fingerprint pool is generated with
  // `exclude_addons: ["UBO"]`, so no session loads uBlock Origin — bundling it
  // would ship a signed copy of AMO's MUTABLE "latest" xpi (no digest to pin),
  // giving a replaced upstream artifact browser-level access to the owner's
  // sessions for no functional gain. Reintroducing uBlock would mean loading it
  // in the pool config AND pinning an exact version + immutable URL + sha256.

  fs.writeFileSync(marker, markerValue);
  log(`camoufox ${arch} install ready at ${installRoot}`);
}

/**
 * Fuse the two per-arch Camoufox install dirs into one universal tree at
 * vendor/camoufox-browser/universal — what `just package` bundles. lipo saves
 * nothing on the binaries themselves (a fat file is the two thin slices
 * concatenated); the win is everything else: the arch-independent payload
 * (omni.ja, localization, …) ships once instead of twice.
 *
 * Merge rules, enforced loudly so a future browser bump can't silently ship a
 * broken merge: every Mach-O must have a twin in the other arch (lipo-fused);
 * every other file must be byte-identical across arches, with two exceptions
 * where arm64's copy wins:
 *   - application.ini / platform.ini differ only in BuildID (camoufox's CI
 *     builds the two arches minutes apart) — asserted line-by-line below. The
 *     inis are what Gecko reports as its buildid, so both slices behave
 *     identically; the compiled-in buildid is only crash-report/telemetry
 *     metadata.
 *   - the top-level omni.ja, whose only cross-arch diff is the
 *     about:buildconfig page naming the build arch (verified for
 *     152.0.4-beta.28).
 */
function mergeCamoufoxUniversal() {
  const outRoot = path.join(browserDir, "universal");
  const marker = path.join(outRoot, ".sha256");
  const markerValue = [
    lock.camoufox.assets.arm64.sha256,
    lock.camoufox.assets.x64.sha256,
    PRUNE_VERSION,
  ].join(":");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === markerValue) {
    log("camoufox universal up to date");
    return;
  }

  // The sweep below requires the two per-arch trees to be byte-identical outside
  // Mach-O, so patch both before comparing them: one cached (already patched)
  // and one freshly extracted is otherwise a diff. The universal tree is dittoed
  // from arm64, so it inherits the patch rather than needing its own.
  patchCamoufoxDockPolicies();

  const installPathOf = (root) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    return path.join(root, cfg.active_version);
  };
  const armInstall = installPathOf(path.join(browserDir, "arm64"));
  const intelInstall = installPathOf(path.join(browserDir, "x86_64"));

  const [repo, fullVersion] = lock.camoufox.browserVersion.split("/");
  const folder = `${fullVersion}-universal`;
  const outInstall = path.join(outRoot, "browsers", repo, folder);
  fs.rmSync(outRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outInstall), { recursive: true });

  log("fusing camoufox universal tree");
  run("ditto", [armInstall, outInstall]); // preserves symlinks + exec bits

  // Non-Mach-O files allowed to differ across the per-arch zips. A checker of
  // null means the diff is trusted as-is; otherwise it must return true.
  const sameExceptBuildId = (aFile, bFile) => {
    const strip = (f) => fs.readFileSync(f, "utf8").replace(/^BuildID=.*$/m, "BuildID=");
    return strip(aFile) === strip(bFile);
  };
  const allowedDiff = new Map([
    ["Camoufox.app/Contents/Resources/omni.ja", null],
    ["Camoufox.app/Contents/Resources/application.ini", sameExceptBuildId],
    ["Camoufox.app/Contents/Resources/platform.ini", sameExceptBuildId],
  ]);

  let fused = 0;
  for (const macho of machOFiles(outInstall)) {
    const rel = path.relative(outInstall, macho);
    const armFile = path.join(armInstall, rel);
    const intelFile = path.join(intelInstall, rel);
    if (!fs.existsSync(intelFile)) {
      throw new Error(`arm64-only Mach-O with no x86_64 twin: ${rel}`);
    }
    run("lipo", ["-create", armFile, intelFile, "-output", macho], { quiet: true });
    fs.chmodSync(macho, fs.statSync(armFile).mode);
    const archs = capture("lipo", ["-archs", macho]).trim().split(/\s+/);
    if (!archs.includes("arm64") || !archs.includes("x86_64")) {
      throw new Error(`fused ${rel} is not universal (archs: ${archs.join(", ")})`);
    }
    fused++;
  }
  log(`  ${fused} Mach-O files fused`);

  // Sweep the x86_64 tree: no file may exist only there, and every non-Mach-O
  // must match arm64's bytes unless allow-listed.
  const verify = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      const rel = path.relative(intelInstall, p);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        verify(p);
        continue;
      }
      if (rel === "version.json") continue; // ours, rewritten below
      const armFile = path.join(armInstall, rel);
      if (!fs.existsSync(armFile)) throw new Error(`x86_64-only file: ${rel}`);
      if (allowedDiff.has(rel)) {
        const checker = allowedDiff.get(rel);
        if (checker && !checker(armFile, p)) {
          throw new Error(`allow-listed file diverges beyond its known diff: ${rel}`);
        }
        continue;
      }
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      const magic = buf.readUInt32BE(0);
      if ([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) continue; // fused above
      if (!fs.readFileSync(p).equals(fs.readFileSync(armFile))) {
        throw new Error(`unexpected cross-arch diff in non-Mach-O file: ${rel}`);
      }
    }
  };
  verify(intelInstall);

  // The install-dir bookkeeping (same layout fetchBrowser writes per arch).
  const dash = fullVersion.indexOf("-");
  const version = dash === -1 ? fullVersion : fullVersion.slice(0, dash);
  const build = dash === -1 ? "" : fullVersion.slice(dash + 1);
  fs.writeFileSync(
    path.join(outInstall, "version.json"),
    JSON.stringify({
      version,
      build,
      prerelease: true,
      sha256: lock.camoufox.assets.arm64.sha256,
      sha256_x64: lock.camoufox.assets.x64.sha256,
    }),
  );
  fs.writeFileSync(
    path.join(outRoot, "config.json"),
    JSON.stringify({ active_version: `browsers/${repo}/${folder}` }),
  );
  fs.writeFileSync(path.join(outRoot, ".0.5_FLAG"), "");
  // No addons are fused: none is bundled (see fetchBrowser). Deliberately NOT
  // copying arm64/addons — a copy would both fail on a clean tree (no such dir)
  // and, worse, re-import a leftover UBO from a cache built before it was
  // dropped. The PRUNE_VERSION bump above rebuilds any such cache clean.

  fs.writeFileSync(marker, markerValue);
  log(`camoufox universal install ready at ${outRoot}`);
}

/**
 * Re-sign a Camoufox install dir with the Developer ID + Mozilla's entitlement
 * set. Own pass (cache-independent). Inside-out: the nested helper .apps
 * (gpu-helper, plugin-container, media-plugin-helper), all loose dylibs and
 * XUL, then the main Camoufox.app last.
 */
function signCamoufox(arch, identity) {
  const installRoot = path.join(browserDir, arch);
  if (!fs.existsSync(installRoot)) return;
  const entitlements = path.join(repoRoot, "apps/desktop/build/entitlements.browser.plist");
  const sign = (target) =>
    run(
      "codesign",
      ["--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements, "--sign", identity, target],
      { quiet: true },
    );

  // Find the Camoufox.app.
  let appPath = null;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name === "Camoufox.app") appPath = path.join(dir, e.name);
      else if (!e.name.endsWith(".app")) walk(path.join(dir, e.name));
    }
  };
  walk(installRoot);
  if (!appPath) throw new Error(`no Camoufox.app under ${installRoot}`);

  const macos = path.join(appPath, "Contents", "MacOS");
  // 1) nested helper .apps, inside-out (their own Mach-Os, then the bundle).
  for (const entry of fs.readdirSync(macos, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith(".app")) {
      const helper = path.join(macos, entry.name);
      for (const m of machOFiles(helper)) sign(m);
      sign(helper);
    }
  }
  // 2) every remaining loose Mach-O (dylibs, XUL, camoufox, pingsender…).
  for (const m of machOFiles(appPath)) {
    if (!m.includes(".app/Contents/MacOS/") || path.dirname(m) === macos) sign(m);
  }
  // 3) the app bundle itself, last.
  sign(appPath);
  log(`signed Camoufox (${arch}) with Developer ID`);
}

// ---------------------------------------------------------------------------
// Fingerprint pool
// ---------------------------------------------------------------------------
/**
 * Sample a pool of macOS Camoufox launch configs and freeze them as
 * packages/browser-server/fingerprints.json — the "frozen pool" the runtime
 * picks from, pinned per install (DESIGN.md §11a). This is the ONLY place
 * camoufox-js runs: at build time, where its native deps (better-sqlite3 for the
 * WebGL model, impit) are free. The runtime ships neither it nor Python.
 *
 * camoufox-js reads the browser's own properties.json to validate the config, so
 * it needs the fetched tree; it resolves the install via CAMOUFOX_INSTALL_DIR,
 * which it reads at module load — hence the shim dir and the dynamic import
 * after the env is set. `os: "macos"` is the device's honest fingerprint;
 * exclude_addons keeps the config free of build-time addon paths so a frozen
 * entry is relocatable.
 */
const POOL_SIZE = Number(process.env.DOMO_FINGERPRINT_POOL_SIZE ?? "50");

async function generateFingerprintPool(treeArch) {
  const installRoot = path.join(browserDir, treeArch);
  // browsers/official/<folder>/Camoufox.app — the one the fetch created.
  const official = path.join(installRoot, "browsers", "official");
  const folder = fs.readdirSync(official)[0];
  const app = path.join(official, folder, "Camoufox.app");
  const version = JSON.parse(
    fs.readFileSync(path.join(official, folder, "version.json"), "utf8"),
  );
  // Shim in the layout camoufox-js expects: Camoufox.app + version.json
  // {version, release}. Ours writes {version, build}; translate `build`.
  // downloadsDir only exists as a side effect of download(); on a warm CI
  // cache the fetch is skipped and nothing else creates it, and mkdtemp
  // won't create the parent.
  fs.mkdirSync(downloadsDir, { recursive: true });
  const shim = fs.mkdtempSync(path.join(downloadsDir, "cfx-shim-"));
  fs.symlinkSync(app, path.join(shim, "Camoufox.app"));
  fs.writeFileSync(
    path.join(shim, "version.json"),
    JSON.stringify({ version: version.version, release: version.build }),
  );
  process.env.CAMOUFOX_INSTALL_DIR = shim;
  const { launchOptions } = await import("camoufox-js");

  log(`sampling ${POOL_SIZE} macOS fingerprints from ${treeArch}`);
  const entries = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const o = await launchOptions({ os: "macos", headless: true, exclude_addons: ["UBO"] });
    // Only the CAMOU_CONFIG chunks are the disguise; nothing else camoufox-js
    // put in env is a runtime dependency on macOS. firefoxUserPrefs and args
    // ride along; args is empty for this config shape, but keep it for safety.
    const env = {};
    for (const [k, v] of Object.entries(o.env ?? {})) {
      if (k.startsWith("CAMOU_CONFIG")) env[k] = v;
    }
    const id = crypto.createHash("sha256").update(JSON.stringify(env)).digest("hex").slice(0, 16);
    entries.push({ id, env, firefoxUserPrefs: o.firefoxUserPrefs ?? {}, args: o.args ?? [] });
  }
  fs.rmSync(shim, { recursive: true, force: true });

  const outDir = path.join(repoRoot, "packages", "browser-server");
  const out = path.join(outDir, "fingerprints.json");
  fs.writeFileSync(
    out,
    JSON.stringify({ browserVersion: lock.camoufox.browserVersion, entries }, null, 0),
  );
  log(`wrote ${entries.length} fingerprints to ${path.relative(repoRoot, out)}`);
}

// ---------------------------------------------------------------------------
try {
  const builtArches = [];
  if (wantBrowser) {
    const hostArch = process.arch === "arm64" ? "arm64" : "x86_64";
    if (wantBoth) {
      // The per-arch trees are intermediates; the universal fuse is what gets
      // bundled (and therefore what gets the Developer ID signature).
      fetchBrowser("arm64");
      fetchBrowser("x86_64");
      mergeCamoufoxUniversal();
      builtArches.push("universal");
    } else {
      fetchBrowser(hostArch);
      builtArches.push(hostArch);
    }
  }
  // After the fetch/merge so freshly extracted trees are covered too.
  patchCamoufoxDockPolicies();

  // The frozen fingerprint pool, sampled from whatever tree was just built.
  if (builtArches.length) await generateFingerprintPool(builtArches[0]);

  // Signing is its own pass, cache-independent: a `just package` on an already
  // built tree must still produce Developer ID signatures, or notarization
  // rejects the ad-hoc ones. Without an identity we leave dev signatures alone.
  const identity = process.env.CODESIGN_IDENTITY;
  if (identity) {
    for (const a of builtArches) signCamoufox(a, identity);
  } else {
    log("CODESIGN_IDENTITY not set — keeping existing/ad-hoc signatures (dev mode)");
  }
} catch (error) {
  process.stderr.write(`\n[browser-runtime] FAILED: ${error.message}\n`);
  process.exit(1);
}
