/**
 * electron-builder afterPack hook — runs AFTER @electron/universal merges the
 * x64 + arm64 slices and BEFORE code signing (see macPackager.doUniversalPack).
 *
 * The universal merger rewrites every Info.plist it finds (injecting
 * ElectronAsarIntegrity), which breaks the code-signature seal of the nested
 * Camoufox BUNDLE under Contents/Resources/browser-runtime — and
 * electron-builder exposes no way to exclude it. So we re-sign that tree here
 * with Mozilla's entitlements. `mac.signIgnore` then keeps electron-builder's
 * own signer off it, and notarization sees valid, hardened-runtime, timestamped
 * signatures sealing the current plists. (No Python ships any more; the browser
 * server is a Node script in app.asar.unpacked, signed by electron-builder's own
 * signer with the app entitlements, like the native-keychain addon.)
 *
 * Each Camoufox.app is deep-signed so its Info.plist seal is regenerated.
 *
 * We also drop non-signable build leftovers (.o objects, .a archives) that
 * would otherwise fail notarization ("binary is not signed").
 */
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

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

/**
 * The architectures a Mach-O file carries, read from its own header — no
 * `lipo` subprocess, so the check is deterministic and a test can assert it
 * with crafted bytes. Fat headers list cputypes; a thin file reports its one.
 */
function machOArchs(file) {
  const CPU = { 0x01000007: "x86_64", 0x0100000c: "arm64" };
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(8);
    if (fs.readSync(fd, head, 0, 8, 0) < 8) return [];
    const magic = head.readUInt32BE(0);
    if (magic === 0xcafebabe) {
      // Universal: nfat_arch entries of 20 bytes each, cputype first.
      const count = head.readUInt32BE(4);
      const archs = [];
      for (let i = 0; i < count; i++) {
        const entry = Buffer.alloc(4);
        if (fs.readSync(fd, entry, 0, 4, 8 + i * 20) < 4) break;
        const name = CPU[entry.readUInt32BE(0)];
        if (name) archs.push(name);
      }
      return archs;
    }
    if (magic === 0xfeedfacf) return [CPU[head.readUInt32BE(4)] ?? "?"]; // big-endian file? not on macOS
    if (magic === 0xcffaedfe) {
      // Thin 64-bit, little-endian (the real case): cputype is LE at offset 4.
      return [CPU[head.readUInt32LE(4)] ?? "?"];
    }
    return [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The two-arch invariant every shipped binary answers to: a thin file clears
 * every gate on the packaging Mac and lands broken on the other arch's
 * users. `hint` is the remedy worth naming when there is one.
 */
function assertUniversalMachO(what, file, hint = "") {
  const archs = machOArchs(file);
  const missing = ["x86_64", "arm64"].find((arch) => !archs.includes(arch));
  if (missing) {
    throw new Error(
      `[afterPack] the ${what} is missing ${missing} (carries: ${archs.join(", ") || "nothing"})${hint ? ` — ${hint}` : ""}`,
    );
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
    // load it and browsing is dead in an app that otherwise looks healthy.
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
  // What a packaged build cannot work without. The runtime under browser-runtime
  // is now just the Camoufox tree; the server ships in app.asar.unpacked and the
  // vault ships no payload (TypeScript + a Keychain item).
  const camoufox = path.join(runtime, "camoufox");
  // Absent and empty are one condition: a payload carrying nothing signs
  // nothing, verifies vacuously, and ships the same app. walk() recurses and
  // stops at the first file, so a tree of empty directories still reads bare.
  const bare = (d) => !fs.existsSync(d) || walk(d).next().done === true;
  if (bare(camoufox)) {
    throw new Error(
      "[afterPack] the packed app is missing the camoufox browser payload — " +
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
  // The vault's Keychain root: the native-keychain addon MUST be in the packed
  // app and universal. Its install script is tolerant on purpose (a dev box
  // without Xcode CLT still installs, the key store falls back), but a RELEASE
  // that shipped without it would silently downgrade every new vault from the
  // SecItem access group to safeStorage — a guarantee this hook exists to
  // enforce, not to hope for. Both arches checked for the same reason the
  // providers are: a thin addon clears every gate on the packaging Mac and
  // lands broken on the other arch's users.
  const keychainAddon = path.join(
    context.appOutDir, appName, "Contents", "Resources",
    "app.asar.unpacked", "node_modules", "@domo", "native-keychain", "build", "Release", "keychain.node",
  );
  if (!fs.existsSync(keychainAddon) || fs.statSync(keychainAddon).size === 0) {
    throw new Error(
      "[afterPack] the packed app has no native-keychain addon — " +
        "its build failed (see `npm rebuild @domo/native-keychain`); a release must carry the vault's SecItem provider",
    );
  }
  assertUniversalMachO("native-keychain addon", keychainAddon, "rebuild it universal (binding.gyp forces both arches)");

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

  // 1.5) Credential exchange (docs/CREDENTIAL-EXCHANGE.md): embed and sign the
  // credential-provider appex. UNCONDITIONAL, like the keychain addon above:
  // the app is always signed with the AutoFill entitlement now
  // (entitlements.mac.plist, authorized by the checked-in profiles the
  // packaging recipe has already asserted grant it), and a package that kept
  // the entitlement while quietly dropping the extension — or the addon, or
  // the Swift shim — would ship a release where the feature silently stopped.
  // Missing pieces fail the build here, in seconds, not in a user report.
  {
    // The two _CX_ overrides exist for afterPack.test.ts alone: the refusals
    // below are pure fs + throw and must be reachable from vitest whatever
    // this checkout happens to have built or fetched. Nothing else sets them.
    const appexSource = process.env.DOMO_CX_APPEX_SOURCE ||
      path.join(__dirname, "..", "dist", "native", "PlowLatchCredentialProvider.appex");
    const appexProfile = process.env.DOMO_CX_PROFILE ||
      path.join(__dirname, "PlowLatchCredentialProvider-DeveloperID.provisionprofile");
    const appexEntitlements = path.join(__dirname, "entitlements.appex.plist");
    const contents = path.join(context.appOutDir, appName, "Contents");
    // The receiving half beside the registration half: the N-API addon that
    // redeems the token and the Swift shim it dlopens. Their builds are
    // tolerant on purpose (dev boxes without Xcode CLT); this is where a
    // release that lost either gets stopped. Universal for the same reason
    // the keychain addon is checked: a thin binary clears every gate on the
    // packaging Mac and lands broken on the other arch's users.
    const receiving = [
      ["credential-import addon", path.join(
        contents, "Resources", "app.asar.unpacked", "node_modules",
        "@domo", "native-credential-import", "build", "Release", "credential_import.node",
      )],
      ["credential-import shim", path.join(contents, "Resources", "native", "libdomo-credential-import.dylib")],
    ];
    for (const [what, file] of receiving) {
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        throw new Error(`[afterPack] the packed app has no ${what} — credential exchange would silently stop working`);
      }
      assertUniversalMachO(what, file);
    }
    if (!fs.existsSync(path.join(appexSource, "Contents", "MacOS", "PlowLatchCredentialProvider"))) {
      throw new Error(
        "[afterPack] dist/native has no built credential-provider appex — " +
          "scripts/build-native.mjs skipped it (no Swift toolchain?)",
      );
    }
    if (!fs.existsSync(appexProfile)) {
      throw new Error(
        "[afterPack] build/PlowLatchCredentialProvider-DeveloperID.provisionprofile is missing",
      );
    }
    const appex = path.join(contents, "PlugIns", "PlowLatchCredentialProvider.appex");
    fs.rmSync(appex, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(appex), { recursive: true });
    fs.cpSync(appexSource, appex, { recursive: true });
    const appexBinary = path.join(appex, "Contents", "MacOS", "PlowLatchCredentialProvider");
    assertUniversalMachO("credential-provider appex", appexBinary);
    // macOS expects a nested bundle's versions to match its app's, and the
    // app's are stamped at package time — so the appex is stamped here, from
    // the same source of truth, before its seal goes on.
    const appPlist = path.join(contents, "Info.plist");
    const readPlist = (key) =>
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, appPlist], { encoding: "utf8" }).trim();
    const appexPlist = path.join(appex, "Contents", "Info.plist");
    for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${readPlist(key)}`, appexPlist]);
    }
    fs.copyFileSync(appexProfile, path.join(appex, "Contents", "embedded.provisionprofile"));
    signFile(appex, appexEntitlements);
    console.log("[afterPack] embedded + signed the credential-provider appex");
  }

  // 2) Camoufox — deep-sign the (universal) Camoufox.app with Mozilla's set.
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

  // 3) Verify EVERY Mach-O carries a Developer ID cert, hardened runtime, and a
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
    `[afterPack] re-signed browser-runtime: ${camoufoxApps.length} Camoufox.app, ` +
      `dropped ${dropped} non-signable files; ` +
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

