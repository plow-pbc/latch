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
  // The packager seals the outer app with its configured identity, so the
  // runtime has to carry that one: two Developer IDs means two team ids, which
  // is the same dead browsing an unsigned runtime causes. Taking it from the
  // packager rather than the environment leaves one source, and an env var that
  // disagrees is a mistake worth stopping for rather than silently overriding.
  const configured = context.packager.platformSpecificBuildOptions.identity;
  // electron-builder spells "do not sign" as an explicit null, which is not the
  // same as leaving it unset. Signing the runtime anyway would put a Developer
  // ID payload under an ad-hoc shell — the two-team split this guard is for.
  if (configured === null) {
    throw new Error(
      "[afterPack] mac.identity is null, so the app ships unsigned — a signed browser runtime under an ad-hoc shell is the split this hook exists to prevent",
    );
  }
  const identity = configured ?? process.env.CODESIGN_IDENTITY;
  if (!identity) {
    // An ad-hoc Mach-O carries no team id, so the hardened runtime refuses to
    // map Python.framework into the python that loads it and browsing is dead
    // in an app that otherwise looks healthy.
    throw new Error(
      "[afterPack] no signing identity — package with `just package` or `just package-unnotarized`",
    );
  }
  if (configured && process.env.CODESIGN_IDENTITY && process.env.CODESIGN_IDENTITY !== configured) {
    throw new Error(
      `[afterPack] CODESIGN_IDENTITY (${process.env.CODESIGN_IDENTITY}) is not the packager's identity (${configured})`,
    );
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const runtime = path.join(context.appOutDir, appName, "Contents", "Resources", "browser-runtime");
  // What a packaged build cannot work without. The vault ships no payload any
  // more: it is TypeScript in dist/ plus a Keychain item, so there is nothing
  // of it here to verify.
  const framework = path.join(runtime, "python", "Python.framework");
  const sitePackages = path.join(runtime, "python", "site-packages");
  const server = path.join(runtime, "server");
  const camoufox = path.join(runtime, "camoufox");
  // Absent and empty are one condition: a payload carrying nothing signs
  // nothing, verifies vacuously, and ships the same app. walk() recurses and
  // stops at the first file, so a tree of empty directories still reads bare.
  const bare = (d) => !fs.existsSync(d) || walk(d).next().done === true;
  // A bare runtime explains all four children, so it is named on its own.
  const missing = bare(runtime)
    ? ["browser-runtime"]
    : [framework, sitePackages, server, camoufox]
        .filter(bare)
        .map((d) => path.basename(d));
  if (missing.length > 0) {
    throw new Error(
      `[afterPack] the packed app is missing ${missing.join(", ")} — ` +
        "package with `just package` or `just package-unnotarized`",
    );
  }
  // Vendored provider CLIs are signed by electron-builder's own signer — they
  // are outside signIgnore's browser-runtime scope and have no nested plists for
  // the universal merge to rewrite. What they need from here is proof each is in
  // the packed app for BOTH arches: a tree carrying only the packaging Mac's
  // arch clears every other gate and reaches the other arch's users with no
  // provider tools at all.
  //
  // The BINARY, with a size — not `bare` on the directory, which passes for a
  // folder carrying only a stray .DS_Store the copy picked up.
  //
  // `await import`, because the manifest is ESM and this hook is not. It is the
  // one list of providers; a literal here was true of one and false of two.
  const { VENDORED } = await import("../../../scripts/vendored-providers.mjs");
  for (const { command, arches } of VENDORED) {
    const dir = path.join(context.appOutDir, appName, "Contents", "Resources", "providers", command);
    const missingArches = Object.keys(arches).filter((a) => {
      const binary = path.join(dir, a, command);
      return !fs.existsSync(binary) || fs.statSync(binary).size === 0;
    });
    if (missingArches.length > 0) {
      throw new Error(
        `[afterPack] the packed app has no ${command} for ${missingArches.join(", ")} — ` +
          `run \`just fetch-vendored ${command}\``,
      );
    }
  }
  // camoufox's interior: a fuse that stopped partway leaves files behind but no
  // bundle to sign.
  const camoufoxApps = findApps(camoufox);
  if (camoufoxApps.length === 0) {
    throw new Error(
      "[afterPack] the camoufox payload holds no Camoufox.app — a fuse that did not finish",
    );
  }

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
  const machos = [...walk(framework)].filter(isMachO).sort((a, b) => b.split("/").length - a.split("/").length);
  for (const f of machos) signFile(f, HELPER_ENTITLEMENTS);
  for (const nested of findBundles(framework, ".app")) signFile(nested, HELPER_ENTITLEMENTS);
  signFile(framework, HELPER_ENTITLEMENTS);

  // 3) Loose site-packages Mach-O (the .so extensions and the Playwright node
  // driver) — individually, deepest first so leaves precede loaders.
  const loose = [...walk(sitePackages)].filter(isMachO).sort((a, b) => b.split("/").length - a.split("/").length);
  for (const f of loose) signFile(f, HELPER_ENTITLEMENTS);

  // 4) Camoufox — deep-sign the (universal) Camoufox.app with Mozilla's set.
  // `--deep` only discovers nested code in the standard locations (MacOS,
  // Frameworks, PlugIns, …); a Mach-O under Resources — gmp-clearkey's CDM
  // stub — keeps whatever signature it shipped with (Mozilla's ad-hoc, which
  // notarization rejects). Sign those individually first; the --deep pass
  // then seals them as resources.
  for (const app of camoufoxApps) {
    const inResources = [...walk(app)]
      .filter(isMachO)
      .filter((f) => path.relative(app, f).startsWith(path.join("Contents", "Resources") + path.sep))
      .sort((a, b) => b.split("/").length - a.split("/").length);
    for (const f of inResources) signFile(f, BROWSER_ENTITLEMENTS);
    signBundle(app, BROWSER_ENTITLEMENTS);
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
      `${camoufoxApps.length} Camoufox.app, dropped ${dropped} non-signable files; ` +
      `verified ${verified} Mach-O (Developer ID + hardened runtime + timestamp)`,
  );
};

/** Every Camoufox.app under a dir (the fused universal tree ships one). */
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
