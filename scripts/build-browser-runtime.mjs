#!/usr/bin/env node
/**
 * Builds the universal (arm64 + x86_64) Python runtime for the browser stack
 * into gitignored vendor/ dirs, deterministically and cached:
 *
 *   vendor/python-runtime/Python.framework   relocatable python.org universal2 3.12
 *   vendor/python-runtime/site-packages      lipo-merged universal wheel install
 *   vendor/camoufox-browser/<arch>/Camoufox.app   (--browser / --browser-both)
 *
 * Sources and pins live in vendor/browser-server/runtime.lock.json +
 * requirements.txt. Downloads are cached in vendor/downloads/. A stamp file
 * makes re-runs no-ops until the pins change.
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
const runtimeDir = path.join(vendorDir, "python-runtime");
const downloadsDir = path.join(vendorDir, "downloads");
const browserDir = path.join(vendorDir, "camoufox-browser");
const vaultCliDir = path.join(vendorDir, "vault-cli");

const lock = JSON.parse(fs.readFileSync(path.join(serverDir, "runtime.lock.json"), "utf8"));
const requirementsPath = path.join(serverDir, "requirements.txt");

const PYVER = "3.12";
const fw = path.join(runtimeDir, "Python.framework");
const pybin = path.join(fw, "Versions", PYVER, "bin", `python${PYVER}`);
const sitePackages = path.join(runtimeDir, "site-packages");

const args = process.argv.slice(2);
const wantBrowser = args.includes("--browser") || args.includes("--browser-both");
const wantBoth = args.includes("--browser-both");

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

// ---------------------------------------------------------------------------
// Stamp: skip everything when the pins haven't changed.
// ---------------------------------------------------------------------------
const stampPath = path.join(runtimeDir, ".stamp");
const stamp = crypto
  .createHash("sha256")
  .update(fs.readFileSync(path.join(serverDir, "runtime.lock.json")))
  .update(fs.readFileSync(requirementsPath))
  .digest("hex");

function buildRuntime() {
  if (fs.existsSync(stampPath) && fs.readFileSync(stampPath, "utf8") === stamp) {
    log("runtime up to date (stamp matches)");
    return;
  }
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  // 1. python.org universal2 framework -----------------------------------
  const pkgDest = path.join(downloadsDir, path.basename(lock.python.url));
  download(lock.python.url, lock.python.sha256, pkgDest);

  log("expanding Python.framework");
  const expanded = path.join(downloadsDir, "python-pkg-expanded");
  fs.rmSync(expanded, { recursive: true, force: true });
  run("pkgutil", ["--expand-full", pkgDest, expanded]);
  const fwPayload = path.join(expanded, "Python_Framework.pkg", "Payload");
  if (!fs.existsSync(path.join(fwPayload, "Versions"))) {
    throw new Error(`unexpected pkg layout: no Versions/ under ${fwPayload}`);
  }
  run("ditto", [fwPayload, fw]);
  fs.rmSync(expanded, { recursive: true, force: true });

  // 2. Prune what we never need (saves ~90 MB, removes GUI/Tcl payloads) ---
  const v = path.join(fw, "Versions", PYVER);
  for (const doomed of [
    `lib/python${PYVER}/test`,
    `lib/python${PYVER}/idlelib`,
    `lib/python${PYVER}/tkinter`,
    `lib/python${PYVER}/turtledemo`,
    "share",
    "Resources/English.lproj",
  ]) {
    fs.rmSync(path.join(v, doomed), { recursive: true, force: true });
  }
  for (const bin of fs.readdirSync(path.join(v, "bin"))) {
    // -intel64 is a thin Rosetta launcher; the fat python3.12 covers both archs.
    if (/^(idle|2to3|pydoc)/.test(bin) || bin.endsWith("-intel64")) {
      fs.rmSync(path.join(v, "bin", bin), { force: true });
    }
  }
  for (const lib of fs.readdirSync(path.join(v, "lib"))) {
    if (/^(libtcl|libtk|tcl|tk|itcl|Tk|thread)/i.test(lib)) {
      fs.rmSync(path.join(v, "lib", lib), { recursive: true, force: true });
    }
  }
  // _tkinter can't work without Tcl — drop it so a stray import fails cleanly.
  const dynload = path.join(v, `lib/python${PYVER}/lib-dynload`);
  for (const so of fs.readdirSync(dynload)) {
    if (so.startsWith("_tkinter")) fs.rmSync(path.join(dynload, so), { force: true });
  }
  // Static archives (.a, an ar archive — not Mach-O magic) and relocatable
  // objects (.o) are build-time artifacts, never loaded at runtime, and CANNOT
  // carry a hardened signature — codesign stamps them "generic" with no secure
  // timestamp and notarization rejects them. Sweep every one from the framework.
  const sweepArtifacts = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) sweepArtifacts(p);
      else if (entry.name.endsWith(".o") || entry.name.endsWith(".a")) fs.rmSync(p, { force: true });
    }
  };
  sweepArtifacts(fw);
  // config-3.12-darwin exists only to compile/embed against libpython; nothing
  // in it is needed to RUN scripts.
  fs.rmSync(path.join(v, `lib/python${PYVER}/config-${PYVER}-darwin`), {
    recursive: true,
    force: true,
  });

  // 3. Make it relocatable (the python.org build hardcodes /Library/...) ---
  // Every framework-internal reference (the Python dylib, OpenSSL in lib/,
  // …) becomes @loader_path-relative in the file that holds it, so the tree
  // works from any location with no rpath bookkeeping.
  log("relocating install names");
  const fwPrefix = `/Library/Frameworks/Python.framework/Versions/${PYVER}/`;
  for (const macho of machOFiles(fw)) {
    const changes = [];
    const lines = capture("otool", ["-L", macho]).split("\n").slice(1);
    const refs = lines
      .map((l) => l.trim().split(" (")[0])
      .filter((r) => r.startsWith(fwPrefix));
    // A dylib's own id also appears in -L output; handle it as -id.
    let id = "";
    try {
      id = capture("otool", ["-D", macho]).split("\n")[1]?.trim() ?? "";
    } catch {
      /* not a dylib */
    }
    if (id.startsWith(fwPrefix)) {
      changes.push("-id", `@rpath/${id.slice(fwPrefix.length)}`);
    }
    for (const ref of refs) {
      if (ref === id) continue;
      const target = path.join(v, ref.slice(fwPrefix.length));
      const rel = path.relative(path.dirname(macho), target);
      changes.push("-change", ref, `@loader_path/${rel}`);
    }
    if (changes.length > 0) {
      run("install_name_tool", [...changes, macho], { quiet: true });
      adhocSign(macho); // modification invalidates the signature; arm64 kills unsigned
    }
  }

  // Sweep: nothing may still reference /Library/Frameworks (ids excepted —
  // they are names, not lookups — but we rewrote those too).
  for (const macho of machOFiles(fw)) {
    const links = capture("otool", ["-L", macho]);
    if (links.includes("/Library/Frameworks/Python.framework")) {
      throw new Error(`unrelocated reference in ${macho}:\n${links}`);
    }
  }

  // 4. Sanity: the relocated interpreter must run from here ----------------
  const versionOut = capture(pybin, ["--version"]).trim();
  log(`relocated interpreter: ${versionOut}`);
  run(pybin, ["-m", "ensurepip", "--upgrade"], { quiet: true });

  // 5. Per-arch wheel download -------------------------------------------
  // System python3 downloads; the wheels themselves are for OUR runtime
  // (cp312, macOS). Target macosx_14_0 accepts every earlier per-arch tag.
  const wheelDirs = { arm64: path.join(downloadsDir, "wheels-arm64"), x86_64: path.join(downloadsDir, "wheels-x86_64") };
  for (const [arch, dir] of Object.entries(wheelDirs)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    log(`pip download (${arch})`);
    run("python3", [
      "-m", "pip", "download",
      "-r", requirementsPath,
      "--dest", dir,
      "--only-binary", ":all:",
      "--implementation", "cp",
      "--python-version", PYVER,
      "--abi", "cp312", "--abi", "abi3", "--abi", "none",
      "--platform", `macosx_14_0_${arch}`,
      "--platform", "macosx_10_13_universal2",
      "--platform", "macosx_11_0_universal2",
      "--quiet",
    ]);
    // Playwright's "universal2" wheel bundles an x86_64-only node driver
    // (Rosetta-dependent). Replace it with the true per-arch wheel — exact
    // platform tags so pip cannot prefer universal2 again — and the merge
    // step lipo-fuses a genuinely universal driver.
    const pwPin = fs.readFileSync(requirementsPath, "utf8").match(/^playwright==\S+/m)?.[0];
    if (pwPin) {
      for (const f of fs.readdirSync(dir)) {
        if (/^playwright-.*universal2/.test(f)) fs.rmSync(path.join(dir, f));
      }
      const exactPlatform = arch === "arm64" ? "macosx_11_0_arm64" : "macosx_10_13_x86_64";
      run("python3", [
        "-m", "pip", "download", pwPin,
        "--dest", dir, "--no-deps",
        "--only-binary", ":all:",
        "--implementation", "cp",
        "--python-version", PYVER,
        "--abi", "cp312", "--abi", "abi3", "--abi", "none",
        "--platform", exactPlatform,
        "--quiet",
      ]);
    }
  }

  // 6. Merge into a universal wheel set ----------------------------------
  log("merging per-arch wheels (delocate)");
  const delocateLib = path.join(downloadsDir, "delocate-lib");
  if (!fs.existsSync(path.join(delocateLib, "delocate"))) {
    run(pybin, ["-m", "pip", "install", "--quiet", "--target", delocateLib, "delocate"], {});
  }
  const mergedDir = path.join(downloadsDir, "wheels-merged");
  fs.rmSync(mergedDir, { recursive: true, force: true });
  fs.mkdirSync(mergedDir, { recursive: true });

  const armWheels = fs.readdirSync(wheelDirs.arm64);
  const intelWheels = fs.readdirSync(wheelDirs.x86_64);
  const nameVer = (f) => f.split("-").slice(0, 2).join("-");
  const isUniversal = (f) => f.includes("universal2");
  // Cython is screeninfo's darwin-marker leftover build dep — its macOS code
  // imports AppKit, never Cython. Its wheels are also ABI-mismatched across
  // arches (cp312 vs abi3), so exclude it rather than fuse garbage.
  const excluded = (f) => /^cython-/i.test(f);
  for (const wheel of armWheels) {
    if (excluded(wheel)) continue;
    const armPath = path.join(wheelDirs.arm64, wheel);
    if (intelWheels.includes(wheel) || isUniversal(wheel)) {
      fs.copyFileSync(armPath, path.join(mergedDir, wheel)); // pure or already universal2
      continue;
    }
    const partner = intelWheels.find((f) => nameVer(f) === nameVer(wheel));
    if (!partner) throw new Error(`no x86_64 counterpart for ${wheel}`);
    if (isUniversal(partner)) {
      fs.copyFileSync(path.join(wheelDirs.x86_64, partner), path.join(mergedDir, partner));
      continue;
    }
    log(`  fusing ${nameVer(wheel)}`);
    run(pybin, [
      "-c",
      "import sys; from delocate.fuse import fuse_wheels; fuse_wheels(sys.argv[1], sys.argv[2], sys.argv[3])",
      armPath,
      path.join(wheelDirs.x86_64, partner),
      path.join(mergedDir, wheel.replace(/macosx_[0-9_]+_arm64/, "macosx_10_13_universal2")),
    ], { env: { ...process.env, PYTHONPATH: delocateLib } });
  }
  for (const wheel of intelWheels) {
    if (excluded(wheel)) continue;
    if (!armWheels.includes(wheel) && !armWheels.some((f) => nameVer(f) === nameVer(wheel))) {
      throw new Error(`x86_64-only wheel with no arm64 counterpart: ${wheel}`);
    }
  }

  // 7. Install the merged set --------------------------------------------
  // --no-deps with the explicit wheel list: pip download already resolved the
  // closure, and resolving again would re-demand the excluded Cython.
  log("installing site-packages");
  const mergedWheels = fs.readdirSync(mergedDir).map((f) => path.join(mergedDir, f));
  run(pybin, [
    "-m", "pip", "install",
    "--quiet", "--no-index", "--no-deps", "--no-compile",
    "--target", sitePackages,
    ...mergedWheels,
  ]);

  // 8. Verify: every native module is universal; imports work natively ----
  log("verifying universality");
  let checked = 0;
  for (const macho of machOFiles(sitePackages)) {
    const archs = capture("lipo", ["-archs", macho]).trim().split(/\s+/);
    if (!archs.includes("arm64") || !archs.includes("x86_64")) {
      throw new Error(`${macho} is not universal (archs: ${archs.join(", ")})`);
    }
    checked++;
  }
  log(`  ${checked} Mach-O files universal`);
  const smoke = "import camoufox, playwright, lxml, numpy, orjson, tldextract; print('imports ok')";
  const smokeEnv = { ...process.env, PYTHONPATH: sitePackages, PYTHONNOUSERSITE: "1" };
  run(pybin, ["-c", smoke], { env: smokeEnv, quiet: true });
  log("  native smoke import ok");
  const rosetta = spawnSync("arch", ["-x86_64", "/usr/bin/true"]).status === 0;
  if (rosetta && process.arch === "arm64") {
    run("arch", ["-x86_64", pybin, "-c", smoke], { env: smokeEnv, quiet: true });
    log("  x86_64 (Rosetta) smoke import ok");
  }

  fs.writeFileSync(stampPath, stamp);
  log("runtime build complete");
}

/**
 * Sign the Python runtime with the Developer ID. Runs as its own pass (not
 * gated by the build cache) so a rebuild-less `just package` still signs.
 * Every Mach-O gets the helper entitlements; electron-builder is told to skip
 * this tree (signIgnore) so it can't re-sign with the wrong entitlements.
 */
function signRuntime(identity) {
  const entitlements = path.join(repoRoot, "apps/desktop/build/entitlements.helper.plist");
  let n = 0;
  // Inside-out: leaf dylibs/.so first, the framework's own Python dylib and
  // the interpreter last (they load the leaves).
  const files = [...machOFiles(fw), ...machOFiles(sitePackages)].sort(
    (a, b) => b.split("/").length - a.split("/").length,
  );
  for (const macho of files) {
    run(
      "codesign",
      ["--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements, "--sign", identity, macho],
      { quiet: true },
    );
    n++;
  }
  log(`signed ${n} runtime Mach-O files with Developer ID`);
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
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === asset.sha256) {
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
  fs.writeFileSync(
    path.join(installPath, "version.json"),
    JSON.stringify({ version, build, prerelease: true, sha256: asset.sha256 }),
  );
  fs.writeFileSync(
    path.join(installRoot, "config.json"),
    JSON.stringify({ active_version: `browsers/${repo}/${folder}` }),
  );
  fs.writeFileSync(path.join(installRoot, ".0.5_FLAG"), "");

  // Pre-bundle the default addon (uBlock Origin): camoufox downloads it at
  // first launch when missing, and in a packaged app the payload is sealed by
  // the signature — a runtime write would break it. AMO's "latest" URL can't
  // be hash-pinned; the addon is an ad-blocker, not protocol-critical.
  const uboDir = path.join(installRoot, "addons", "UBO");
  const uboZip = path.join(downloadsDir, "ubo-latest.xpi");
  if (!fs.existsSync(uboZip)) {
    log("downloading uBlock Origin addon");
    run("curl", ["-fsSL", "-o", uboZip,
      "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi"]);
  }
  fs.mkdirSync(uboDir, { recursive: true });
  run("ditto", ["-x", "-k", uboZip, uboDir]);

  fs.writeFileSync(marker, asset.sha256);
  log(`camoufox ${arch} install ready at ${installRoot}`);
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
// Vault CLI payload (the credential broker's `bw`)
// ---------------------------------------------------------------------------
/**
 * Unpacks Bitwarden's standalone CLI into vendor/vault-cli/<arch>/bw, so the
 * broker finds one inside the app and the user installs nothing. Same shape as
 * the camoufox payload: hash-pinned zip, per-arch tree, .sha256 marker.
 *
 * The pinned asset is the `bw-oss-*` build deliberately: the plain `bw-*` one
 * carries Bitwarden-Licensed code we have no right to redistribute.
 */
function fetchVaultCli(arch) {
  const asset = lock.vaultCli.assets[arch === "arm64" ? "arm64" : "x64"];
  const installRoot = path.join(vaultCliDir, arch);
  const marker = path.join(installRoot, ".sha256");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === asset.sha256) {
    log(`vault cli ${arch} up to date`);
    return;
  }
  const zipDest = path.join(downloadsDir, path.basename(new URL(asset.url).pathname));
  download(asset.url, asset.sha256, zipDest);
  log(`extracting vault cli (${arch})`);
  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.mkdirSync(installRoot, { recursive: true });
  run("ditto", ["-x", "-k", zipDest, installRoot]);
  const bw = path.join(installRoot, "bw");
  if (!fs.existsSync(bw)) throw new Error(`no bw binary in ${asset.url}`);
  fs.chmodSync(bw, 0o755); // the zip is built on CI; don't trust its mode bits
  fs.writeFileSync(marker, asset.sha256);
  log(`vault cli ${arch} ready at ${installRoot}`);
}

/** Developer ID + helper entitlements (it is a Node build — V8 needs JIT). */
function signVaultCli(arch, identity) {
  const bw = path.join(vaultCliDir, arch, "bw");
  if (!fs.existsSync(bw)) return;
  const entitlements = path.join(repoRoot, "apps/desktop/build/entitlements.helper.plist");
  run(
    "codesign",
    ["--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements, "--sign", identity, bw],
    { quiet: true },
  );
  log(`signed vault cli (${arch}) with Developer ID`);
}

// ---------------------------------------------------------------------------
try {
  const builtArches = [];
  buildRuntime(); // stamp-cached: fast no-op once built
  if (wantBrowser) {
    const hostArch = process.arch === "arm64" ? "arm64" : "x86_64";
    const arches = wantBoth ? ["arm64", "x86_64"] : [hostArch];
    for (const a of arches) {
      fetchBrowser(a);
      fetchVaultCli(a);
      builtArches.push(a);
    }
  }

  // Signing is its own pass, cache-independent: a `just package` on an already
  // built tree must still produce Developer ID signatures, or notarization
  // rejects the ad-hoc ones. Without an identity we leave dev signatures alone.
  const identity = process.env.CODESIGN_IDENTITY;
  if (identity) {
    signRuntime(identity);
    for (const a of builtArches) {
      signCamoufox(a, identity);
      signVaultCli(a, identity);
    }
  } else {
    log("CODESIGN_IDENTITY not set — keeping existing/ad-hoc signatures (dev mode)");
  }
} catch (error) {
  process.stderr.write(`\n[browser-runtime] FAILED: ${error.message}\n`);
  process.exit(1);
}
