/**
 * electron-builder afterPack hook — runs AFTER @electron/universal merges the
 * x64 + arm64 slices and BEFORE code signing (see macPackager.doUniversalPack).
 *
 * The universal merger rewrites every Info.plist it finds (injecting
 * ElectronAsarIntegrity), which breaks the code-signature seal of the nested
 * Camoufox and Python BUNDLES under Contents/Resources/browser-runtime — and
 * electron-builder exposes no way to exclude them. So we re-sign that tree here
 * with the correct per-payload entitlements. `mac.signIgnore` then keeps
 * electron-builder's own signer off it, and notarization sees valid,
 * hardened-runtime, timestamped signatures sealing the current plists.
 *
 * Bundles (Python.framework, each Camoufox.app) are deep-signed so their
 * Info.plist seals are regenerated; loose Mach-O files (site-packages .so, the
 * Playwright node driver) are signed individually, deepest first.
 *
 * We also drop non-signable build leftovers (.o objects, .a archives) that
 * would otherwise fail notarization ("binary is not signed").
 */
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const HELPER_ENTITLEMENTS = path.join(__dirname, "entitlements.helper.plist");
const BROWSER_ENTITLEMENTS = path.join(__dirname, "entitlements.browser.plist");

function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) < 4) return false;
    return [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(buf.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function* walk(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

module.exports = async function afterPack(context) {
  // Only the final universal app matters; the per-arch temp packs are deleted
  // right after the merge.
  if (context.appOutDir.includes("-temp")) return;
  const identity = process.env.CODESIGN_IDENTITY;
  if (!identity) {
    console.log("[afterPack] CODESIGN_IDENTITY not set — skipping browser-runtime re-sign");
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const runtime = path.join(context.appOutDir, appName, "Contents", "Resources", "browser-runtime");
  if (!fs.existsSync(runtime)) return;

  // 1) Drop non-signable leftovers (belt — the build script prunes them too).
  let dropped = 0;
  for (const f of walk(runtime)) {
    if (f.endsWith(".o") || f.endsWith(".a")) {
      fs.rmSync(f, { force: true });
      dropped++;
    }
  }

  const codesign = (args) =>
    execFileSync("codesign", args, { stdio: ["ignore", "ignore", "pipe"] });
  const signFile = (target, entitlements) =>
    codesign(["--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements, "--sign", identity, target]);
  const signBundle = (target, entitlements) =>
    codesign(["--force", "--deep", "--timestamp", "--options", "runtime", "--entitlements", entitlements, "--sign", identity, target]);

  // 2) Python framework. `codesign --deep` on a FRAMEWORK bundle does not
  // traverse into lib/ and lib-dynload/, so the dylibs and .so we relocated
  // (with install_name_tool, then ad-hoc signed) keep invalid, un-timestamped
  // signatures. Sign every Mach-O in the framework INDIVIDUALLY (deepest
  // first) so each carries a Developer ID cert, hardened runtime, and a secure
  // timestamp. Then seal the nested Python.app bundle (bin/python3.12 execs its
  // binary) and the framework bundle — plain codesign, NOT --deep, so the
  // individually-signed nested Mach-Os keep their timestamps; sealing only
  // re-signs each bundle's main binary and regenerates CodeResources over the
  // merge-rewritten Info.plists.
  const framework = path.join(runtime, "python", "Python.framework");
  if (fs.existsSync(framework)) {
    const machos = [...walk(framework)].filter(isMachO).sort((a, b) => b.split("/").length - a.split("/").length);
    for (const f of machos) signFile(f, HELPER_ENTITLEMENTS);
    for (const nested of findBundles(framework, ".app")) signFile(nested, HELPER_ENTITLEMENTS);
    signFile(framework, HELPER_ENTITLEMENTS);
  }

  // 3) Loose site-packages Mach-O (the .so extensions and the Playwright node
  // driver) — individually, deepest first so leaves precede loaders.
  const sitePackages = path.join(runtime, "python", "site-packages");
  if (fs.existsSync(sitePackages)) {
    const loose = [...walk(sitePackages)].filter(isMachO).sort((a, b) => b.split("/").length - a.split("/").length);
    for (const f of loose) signFile(f, HELPER_ENTITLEMENTS);
  }

  // 4) Camoufox — deep-sign each arch's Camoufox.app with Mozilla's set.
  const camoufox = path.join(runtime, "camoufox");
  let apps = 0;
  if (fs.existsSync(camoufox)) {
    for (const app of findApps(camoufox)) {
      signBundle(app, BROWSER_ENTITLEMENTS);
      apps++;
    }
  }

  // 4b) Vault CLI — one loose Mach-O per arch, helper entitlements (it is a
  // Node build, so V8 needs JIT).
  const vaultCli = path.join(runtime, "vault-cli");
  if (fs.existsSync(vaultCli)) {
    for (const f of walk(vaultCli)) {
      if (isMachO(f)) signFile(f, HELPER_ENTITLEMENTS);
    }
  }

  // 5) Verify EVERY Mach-O carries a Developer ID cert, hardened runtime, and a
  // secure timestamp — the three things notarization checks. Fails the build in
  // seconds instead of after a ~15-minute notarization round-trip.
  const problems = [];
  let verified = 0;
  for (const f of walk(runtime)) {
    if (!isMachO(f)) continue;
    verified++;
    const info = spawnSync("codesign", ["-dvvv", f], { encoding: "utf8" }).stderr || "";
    if (!info.includes("Authority=Developer ID Application")) problems.push([f, "no Developer ID"]);
    else if (!/\bTimestamp=/.test(info)) problems.push([f, "no secure timestamp"]);
    else if (!/flags=.*runtime/.test(info)) problems.push([f, "no hardened runtime"]);
  }
  if (problems.length > 0) {
    const lines = problems
      .slice(0, 15)
      .map(([f, why]) => `  ${why}: ${f.split("browser-runtime/")[1] ?? f}`)
      .join("\n");
    throw new Error(
      `[afterPack] ${problems.length} browser-runtime Mach-O still fail signing checks:\n${lines}`,
    );
  }

  console.log(
    `[afterPack] re-signed browser-runtime: Python.framework + site-packages, ` +
      `${apps} Camoufox.app, dropped ${dropped} non-signable files; ` +
      `verified ${verified} Mach-O (Developer ID + hardened runtime + timestamp)`,
  );
};

/** Every Camoufox.app under a dir (one per shipped arch). */
function findApps(root) {
  const apps = [];
  const rec = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === "Camoufox.app") apps.push(p);
      else if (!e.name.endsWith(".app")) rec(p);
    }
  };
  rec(root);
  return apps;
}

/** All bundles ending in `suffix` under root, deepest first (sign inside-out). */
function findBundles(root, suffix) {
  const found = [];
  const rec = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      rec(p);
      if (e.name.endsWith(suffix)) found.push(p);
    }
  };
  rec(root);
  // Deepest paths first so a nested bundle is signed before its container.
  return found.sort((a, b) => b.split("/").length - a.split("/").length);
}
