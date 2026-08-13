#!/usr/bin/env node
/**
 * Builds the universal (arm64 + x86_64) Python runtime for the browser stack
 * into gitignored vendor/ dirs, deterministically and cached:
 *
 *   vendor/python-runtime/Python.framework   relocatable python.org universal2 3.12
 *   vendor/python-runtime/site-packages      lipo-merged universal wheel install
 *   vendor/camoufox-browser/<arch>/Camoufox.app   (--browser: this arch only)
 *   vendor/camoufox-browser/universal/            (--browser-both: both arches
 *                                                  lipo-fused into one tree —
 *                                                  what `just package` bundles)
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
import { foreignLinks } from "./machoLinks.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const vendorDir = path.join(repoRoot, "vendor");
const serverDir = path.join(vendorDir, "browser-server");
const runtimeDir = path.join(vendorDir, "python-runtime");
const downloadsDir = path.join(vendorDir, "downloads");
const browserDir = path.join(vendorDir, "camoufox-browser");
const vaultCliDir = path.join(vendorDir, "vault-cli");
const vaultServerDir = path.join(vendorDir, "vault-server");

const lock = JSON.parse(fs.readFileSync(path.join(serverDir, "runtime.lock.json"), "utf8"));
const requirementsPath = path.join(serverDir, "requirements.txt");

const PYVER = "3.12";
const fw = path.join(runtimeDir, "Python.framework");
const pybin = path.join(fw, "Versions", PYVER, "bin", `python${PYVER}`);
const sitePackages = path.join(runtimeDir, "site-packages");

const args = process.argv.slice(2);
const wantBrowser = args.includes("--browser") || args.includes("--browser-both");
const wantBoth = args.includes("--browser-both");

// Bump when the pruning/merging logic below changes, so cached trees (which
// are keyed on the download pins) rebuild with the new slimming applied.
const PRUNE_VERSION = "1";

// `vendored_openssl` is not optional. Without it the build links against
// whatever libssl the packaging machine has -- on a dev Mac that is
// /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib, which does not exist on a
// user's Mac, so the bundled vault would refuse to launch for everyone without
// Homebrew. Statically linked, it needs nothing outside the OS.
const VAULT_FEATURES = "sqlite,vendored_openssl";

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
  .update(PRUNE_VERSION)
  .digest("hex");

function buildRuntime() {
  if (fs.existsSync(stampPath) && fs.readFileSync(stampPath, "utf8") === stamp && fs.existsSync(pybin)) {
    // Same reasoning as the vault payloads: the cached path is the one nearly
    // every `just package` takes, so it gets the check too. One probe on the
    // interpreter rather than the full per-Mach-O sweep below, which costs a
    // spawn per file — enough to catch a payload that lost its relocation.
    assertNoForeignLinks(pybin);
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
    `lib/python${PYVER}/pydoc_data`,
    `lib/python${PYVER}/lib2to3`,
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

  // 8. Prune runtime-dead weight from the installed tree -------------------
  // Nothing here is loadable at runtime: test suites, debug symbols, type
  // stubs, C headers, static archives (which also can't carry a hardened
  // signature — see the sweep above), and bytecode caches (the runtime sets
  // PYTHONDONTWRITEBYTECODE=1, so shipped .pyc files are dead weight anyway).
  // License files and .dist-info metadata are deliberately KEPT: redistributing
  // these packages requires retaining their notices, and some packages resolve
  // their own version via importlib.metadata. The smoke import below is the
  // gate against over-pruning.
  log("pruning site-packages");
  const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
  rmrf(path.join(sitePackages, "PyObjCTest")); // pyobjc's bundled test suite (incl. dSYMs)
  for (const doomed of [
    "numpy/f2py", // Fortran-binding generator, a build tool
    "numpy/_core/include",
    "numpy/_core/lib",
    "lxml/includes",
    // Playwright's driver: doc-generation metadata, TS declarations, and the
    // recorder/trace-viewer web bundles — none used by a headless launch.
    "playwright/driver/package/api.json",
    "playwright/driver/package/protocol.yml",
    "playwright/driver/package/types",
    "playwright/driver/package/lib/vite",
  ]) {
    rmrf(path.join(sitePackages, doomed));
  }
  const pruneSweep = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (
          entry.name === "__pycache__" ||
          entry.name === "tests" ||
          entry.name === "test" ||
          entry.name.endsWith(".dSYM")
        ) {
          rmrf(p);
        } else {
          pruneSweep(p);
        }
      } else if (/\.(pyi|h|a|o)$/.test(entry.name)) {
        fs.rmSync(p, { force: true });
      }
    }
  };
  pruneSweep(sitePackages);
  // Build-time-only framework payloads, removable now that pip has run: pip
  // itself (ensurepip put it in the framework's site-packages), ensurepip,
  // the C headers (plus the Headers symlinks that point at them), and the
  // stdlib's shipped bytecode caches.
  const fwSitePackages = path.join(v, `lib/python${PYVER}/site-packages`);
  for (const entry of fs.readdirSync(fwSitePackages)) {
    if (entry.startsWith("pip")) rmrf(path.join(fwSitePackages, entry));
  }
  rmrf(path.join(v, `lib/python${PYVER}/ensurepip`));
  rmrf(path.join(v, "include"));
  fs.rmSync(path.join(v, "Headers"), { force: true });
  fs.rmSync(path.join(fw, "Headers"), { force: true });
  const pycacheSweep = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const p = path.join(dir, entry.name);
      if (entry.name === "__pycache__") rmrf(p);
      else pycacheSweep(p);
    }
  };
  pycacheSweep(path.join(v, `lib/python${PYVER}`));

  // 9. Verify: every native module is universal; imports work natively ----
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
  // camoufox.sync_api pulls the full launch-time import graph (screeninfo,
  // browserforge, playwright.sync_api, …) — the canary against over-pruning.
  const smoke =
    "import camoufox.sync_api, playwright, lxml, numpy, orjson, tldextract; print('imports ok')";
  // PYTHONDONTWRITEBYTECODE: the smoke run must not regenerate the __pycache__
  // dirs the prune above just removed (the runtime sets the same flag).
  const smokeEnv = {
    ...process.env,
    PYTHONPATH: sitePackages,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
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
  // fingerprint can actually render its claimed fonts. server.py pins the
  // fingerprint to macOS (which renders with the system fonts — camoufox's
  // fonts.json mac list is entirely macOS-shipped families), so the bundle
  // is dead weight. Fail loudly if the layout ever moves.
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

  fs.writeFileSync(marker, markerValue);
  log(`camoufox ${arch} install ready at ${installRoot}`);
}

/**
 * Fuse the two per-arch Camoufox install dirs into one universal tree at
 * vendor/camoufox-browser/universal — what `just package` bundles. lipo saves
 * nothing on the binaries themselves (a fat file is the two thin slices
 * concatenated); the win is everything else: the arch-independent payload
 * (omni.ja, addons, …) ships once instead of twice.
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
  run("ditto", [path.join(browserDir, "arm64", "addons"), path.join(outRoot, "addons")]);

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
// Vault server payload (the vault itself, running on the user's Mac)
// ---------------------------------------------------------------------------
/**
 * Builds Vaultwarden from source into vendor/vault-server/<arch>/vaultwarden.
 *
 * Upstream publishes Linux container images and nothing else — no macOS binary,
 * no Homebrew formula, and the crates.io entry is an empty 0.0.1 placeholder —
 * so this is the one payload we compile ourselves. Needs a Rust toolchain on
 * the packaging machine; the pinned rust-toolchain.toml in their tree decides
 * the compiler version, so `rustup` fetches it on first run.
 *
 * The web interface is NOT compiled: it ships as a hash-pinned prebuilt tarball.
 */
function fetchVaultServer(arch) {
  const { repo, commit, version } = lock.vaultServer;
  const installRoot = path.join(vaultServerDir, arch);
  const marker = path.join(installRoot, ".commit");
  // Keyed on the FEATURES as well as the commit: a tree built before
  // `vendored_openssl` is at the same commit but links Homebrew's libssl, and
  // caching on the commit alone would ship it. Same reason `PRUNE_VERSION`
  // exists — build logic changing has to bust the stamp too.
  const vaultStamp = `${commit} ${VAULT_FEATURES}`;
  const cached = path.join(installRoot, "vaultwarden");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === vaultStamp && fs.existsSync(cached)) {
    // Checked on the cached path too — that is the path most packaging runs
    // take, so an assertion that only fires after a compile is an assertion
    // that mostly does not fire. A marker that outlived its binary falls
    // through and rebuilds rather than dying in otool.
    assertNoForeignLinks(cached);
    log(`vault server ${arch} up to date`);
    return;
  }
  const srcDir = path.join(downloadsDir, "vaultwarden-src");
  if (!fs.existsSync(path.join(srcDir, ".git"))) {
    fs.rmSync(srcDir, { recursive: true, force: true });
    log(`cloning vaultwarden ${version}`);
    run("git", ["clone", "--quiet", repo, srcDir]);
  }
  run("git", ["-C", srcDir, "fetch", "--quiet", "origin", commit], { quiet: true });
  run("git", ["-C", srcDir, "checkout", "--quiet", commit], { quiet: true });

  const triple = arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  // The universal app needs both slices, so packaging on an arm64 Mac
  // cross-compiles for x86_64 — a target a fresh `rustup` install does not have.
  // Run INSIDE the source tree: its rust-toolchain.toml pins the toolchain, and
  // the target has to land on that one, not on whatever the default is.
  // A no-op once present, and a far better failure than 200 lines of E0463.
  run("rustup", ["target", "add", triple], { cwd: srcDir, quiet: true });
  log(`compiling vaultwarden (${arch}) — slow, cached by commit`);
  run("cargo", ["build", "--release", "--locked", "--features", VAULT_FEATURES, "--target", triple], {
    cwd: srcDir,
  });
  const built = path.join(srcDir, "target", triple, "release", "vaultwarden");
  if (!fs.existsSync(built)) throw new Error(`cargo produced no binary at ${built}`);
  assertNoForeignLinks(built);

  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.mkdirSync(installRoot, { recursive: true });
  fs.copyFileSync(built, path.join(installRoot, "vaultwarden"));
  fs.chmodSync(path.join(installRoot, "vaultwarden"), 0o755);
  fs.writeFileSync(marker, vaultStamp);
  log(`vault server ${arch} ready at ${installRoot}`);
}

/**
 * A bundled executable may depend on the OS and nothing else. The Homebrew
 * libssl this caught would have failed only on a user's Mac, silently, long
 * after the build said it was fine -- so it fails here instead.
 */
function assertNoForeignLinks(binary) {
  const foreign = foreignLinks(capture("otool", ["-L", binary]));
  if (foreign.length) {
    throw new Error(
      `${path.basename(binary)} links libraries no user's Mac has:\n  ${foreign.join("\n  ")}`,
    );
  }
  log(`${path.basename(binary)}: links only OS libraries`);
}

/** The web interface — prebuilt upstream, arch-independent, hash-pinned. */
function fetchVaultWebUi() {
  const asset = lock.vaultServer.webVault;
  const webRoot = path.join(vaultServerDir, "web-vault");
  const marker = path.join(vaultServerDir, ".web-vault.sha256");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === asset.sha256) {
    log("vault web ui up to date");
    return;
  }
  const tgz = path.join(downloadsDir, path.basename(new URL(asset.url).pathname));
  download(asset.url, asset.sha256, tgz);
  log("extracting vault web ui");
  fs.rmSync(webRoot, { recursive: true, force: true });
  fs.mkdirSync(webRoot, { recursive: true });
  // The tarball holds a single web-vault/ top level; strip it.
  run("tar", ["-xzf", tgz, "-C", webRoot, "--strip-components", "1"]);
  fs.writeFileSync(marker, asset.sha256);
  log(`vault web ui ready at ${webRoot}`);
}

/** Developer ID + helper entitlements, same as the other bundled executables. */
function signVaultServer(arch, identity) {
  const bin = path.join(vaultServerDir, arch, "vaultwarden");
  if (!fs.existsSync(bin)) return;
  const entitlements = path.join(repoRoot, "apps/desktop/build/entitlements.helper.plist");
  run(
    "codesign",
    ["--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements, "--sign", identity, bin],
    { quiet: true },
  );
  log(`signed vault server (${arch}) with Developer ID`);
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
  const cached = path.join(installRoot, "bw");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === asset.sha256 && fs.existsSync(cached)) {
    assertNoForeignLinks(cached);
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
  // Upstream's build, so this is a check on THEM: a `bw` that grew a dependency
  // outside the OS would fail the same way the vault did, on a user's Mac only.
  assertNoForeignLinks(bw);
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
  const vaultArches = [];
  buildRuntime(); // stamp-cached: fast no-op once built
  if (wantBrowser) {
    const hostArch = process.arch === "arm64" ? "arm64" : "x86_64";
    // The vault and its CLI stay per-arch: unlike Camoufox they are single
    // binaries nobody has fused yet (issue #15), so both trees ship and
    // electron-builder passes them through the universal merge.
    fetchVaultWebUi();
    for (const a of wantBoth ? ["arm64", "x86_64"] : [hostArch]) {
      fetchVaultCli(a);
      fetchVaultServer(a);
      vaultArches.push(a);
    }
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

  // Signing is its own pass, cache-independent: a `just package` on an already
  // built tree must still produce Developer ID signatures, or notarization
  // rejects the ad-hoc ones. Without an identity we leave dev signatures alone.
  const identity = process.env.CODESIGN_IDENTITY;
  if (identity) {
    signRuntime(identity);
    for (const a of builtArches) signCamoufox(a, identity);
    for (const a of vaultArches) {
      signVaultCli(a, identity);
      signVaultServer(a, identity);
    }
  } else {
    log("CODESIGN_IDENTITY not set — keeping existing/ad-hoc signatures (dev mode)");
  }
} catch (error) {
  process.stderr.write(`\n[browser-runtime] FAILED: ${error.message}\n`);
  process.exit(1);
}
