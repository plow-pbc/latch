// Compile the native helpers in native/ into dist/native/.
//
// Three artifacts today, all Swift, all built universal (arm64 + x86_64,
// lipo-fused) so each is byte-identical in both of electron-builder's arch
// passes and the universal merge copies it through untouched:
//
//  - settings-window-frame — the window tracker the Full Disk Access grant
//    flow follows System Settings with (see src/permissionFlow.ts).
//  - libdomo-credential-import.dylib — the Swift shim behind receiving an
//    Apple Passwords credential exchange (ASCredentialImportManager is
//    Swift-only API); loaded in-process via @domo/native-credential-import.
//    Targets macOS 13 like the rest — the macOS-26-only symbols weak-link
//    behind #available guards, so the dylib loads everywhere.
//  - PlowLatchCredentialProvider.appex — the do-nothing credential-provider
//    extension whose Info.plist registers the app as a credential-exchange
//    DESTINATION (docs/CREDENTIAL-EXCHANGE.md). Built here unsigned and
//    unembedded; build/afterPack.cjs embeds and signs it at package time,
//    and only when provisioning profiles are present. Targets macOS 26 —
//    its own Info.plist floor — because nothing older ever loads it.
//
// A Mac without the Swift toolchain (no Xcode CLT) still builds and runs the
// app: this script warns and emits nothing, and every consumer degrades (the
// FDA flow falls back to the fixed-position panel, credential exchange
// reports itself unavailable). The output directory is always created so
// electron-builder's extraResources entry never points at a missing source.
//
// The shim has a second floor: the macOS 26 SDK (Xcode 26). #available guards
// only weak-link symbols the SDK DECLARES, and the ASImportable* types the
// shim transcribes were reshaped in 26 — against Xcode 16's SDK the source
// does not compile at all. So on an older SDK the shim is skipped with a
// warning, exactly like the no-toolchain case, and credential exchange is
// unavailable in that build. This is deliberately not a stub dylib: a missing
// shim is what build/afterPack.cjs refuses to package, so a Mac that cannot
// build the feature cannot ship a release that silently lacks it either.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const nativeDir = path.join(dir, "../native");
const outDir = path.join(dir, "../dist/native");

fs.mkdirSync(outDir, { recursive: true });

let swiftc;
let sdk;
let sdkVersion;
try {
  swiftc = execFileSync("xcrun", ["-f", "swiftc"], { encoding: "utf8" }).trim();
  // swiftc run outside of `xcrun` needs the SDK named explicitly, or it can't
  // find the standard library for an -target it wasn't launched under.
  sdk = execFileSync("xcrun", ["--show-sdk-path", "--sdk", "macosx"], { encoding: "utf8" }).trim();
  sdkVersion = execFileSync("xcrun", ["--show-sdk-version", "--sdk", "macosx"], { encoding: "utf8" }).trim();
} catch {
  console.warn(
    "build-native: swiftc not found (no Xcode command line tools) — " +
      "skipping the native helpers; the Full Disk Access panel will not follow System Settings " +
      "and credential exchange will be unavailable",
  );
  process.exit(0);
}

// Keyed on the input bytes AND this script's own: recompiling unchanged
// helpers on every build would put swiftc (~seconds each) in the hot path of
// every `just build`, but a change to how a helper is built (arch policy,
// flags) must invalidate what an older policy produced — a cached artifact
// outlives the script that made it.
const stampOf = (inputs) => {
  const hash = crypto.createHash("sha256");
  for (const input of inputs) hash.update(fs.readFileSync(input));
  hash.update(fs.readFileSync(fileURLToPath(import.meta.url)));
  return hash.digest("hex");
};

/**
 * Build `output` from `inputs` unless the stamp says it is already current.
 * `make(tmp)` must produce the artifact at `output` itself; BOTH arch slices
 * are each artifact's problem, and the output and stamp are written only
 * after the whole build succeeds, so a half-built artifact can never be
 * mistaken for a cached good one.
 */
const build = (label, inputs, output, make) => {
  const stampFile = path.join(outDir, `${path.basename(output)}.stamp`);
  const stamp = stampOf(inputs);
  if (fs.existsSync(output) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === stamp) {
    console.log(`native ${label} up to date → ${output}`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "domo-native-"));
  try {
    make(tmp);
    fs.writeFileSync(stampFile, stamp);
    console.log(`built native ${label} (universal) → ${output}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

/** One swiftc run per arch, lipo-fused. BOTH slices are mandatory: an
 * artifact missing one arch would still package into a "universal" app, and
 * the other arch's users would then load an incompatible binary at runtime. */
const compileUniversal = (tmp, output, { sources, target, extraArgs = [] }) => {
  const slices = ["arm64", "x86_64"].map((arch) => {
    const out = path.join(tmp, `${path.basename(output)}-${arch}`);
    execFileSync(
      swiftc,
      ["-O", "-sdk", sdk, "-target", `${arch}-apple-${target}`, ...extraArgs, ...sources, "-o", out],
      { stdio: "inherit" },
    );
    return out;
  });
  execFileSync("lipo", ["-create", ...slices, "-output", output], { stdio: "inherit" });
};

// 1) The Full Disk Access flow's window tracker (a plain CLI).
{
  const source = path.join(nativeDir, "settings-window-frame.swift");
  const output = path.join(outDir, "settings-window-frame");
  build("helper settings-window-frame", [source], output, (tmp) => {
    compileUniversal(tmp, output, { sources: [source], target: "macos13.0" });
    fs.chmodSync(output, 0o755);
  });
}

// 2) The credential-exchange shim (a dylib the app dlopens in-process).
// Needs the macOS 26 SDK to compile (header comment); an older one skips it.
{
  const source = path.join(nativeDir, "credential-import.swift");
  const output = path.join(outDir, "libdomo-credential-import.dylib");
  const sdkMajor = Number.parseInt(sdkVersion, 10);
  if (!(sdkMajor >= 26)) {
    console.warn(
      `build-native: the macOS SDK is ${sdkVersion} and the credential-import shim needs 26 or later ` +
        "(install Xcode 26) — skipping it; credential exchange will be unavailable in this build " +
        "and `just package` will refuse to ship it",
    );
    // A shim an earlier toolchain left behind would outlive the SDK that made
    // it and ride into a package this Mac can no longer rebuild; the tree
    // reflects what THIS toolchain can produce.
    for (const stale of [output, `${output}.stamp`]) fs.rmSync(stale, { force: true });
  } else {
    build("shim credential-import", [source], output, (tmp) => {
      compileUniversal(tmp, output, {
        sources: [source],
        target: "macos13.0",
        extraArgs: ["-emit-library", "-parse-as-library", "-framework", "AuthenticationServices"],
      });
    });
  }
}

// 3) The credential-provider extension bundle (registration only; vends
// nothing). Assembled as a real .appex tree so afterPack only has to stamp
// versions, embed a profile, sign, and move it under Contents/PlugIns.
{
  const source = path.join(nativeDir, "credential-provider", "CredentialProviderViewController.swift");
  const plist = path.join(nativeDir, "credential-provider", "Info.plist");
  const bundle = path.join(outDir, "PlowLatchCredentialProvider.appex");
  build("extension PlowLatchCredentialProvider.appex", [source, plist], bundle, (tmp) => {
    const binary = path.join(tmp, "PlowLatchCredentialProvider");
    compileUniversal(tmp, binary, {
      sources: [source],
      target: "macos26.0",
      extraArgs: [
        "-parse-as-library",
        "-application-extension",
        "-module-name", "PlowLatchCredentialProvider",
        "-framework", "AuthenticationServices",
        // NSExtensionMain lives in Foundation; named explicitly rather than
        // hoped for transitively.
        "-framework", "Foundation",
        // App extensions have no main of their own; Foundation's
        // NSExtensionMain is the entry point Xcode links them with too.
        "-Xlinker", "-e", "-Xlinker", "_NSExtensionMain",
      ],
    });
    // Assembled in tmp and moved into place whole, so a failure between
    // mkdir and copy can't leave a half-bundle wearing the .appex name.
    const staged = path.join(tmp, "PlowLatchCredentialProvider.appex");
    fs.mkdirSync(path.join(staged, "Contents", "MacOS"), { recursive: true });
    fs.copyFileSync(plist, path.join(staged, "Contents", "Info.plist"));
    fs.copyFileSync(binary, path.join(staged, "Contents", "MacOS", "PlowLatchCredentialProvider"));
    fs.chmodSync(path.join(staged, "Contents", "MacOS", "PlowLatchCredentialProvider"), 0o755);
    fs.rmSync(bundle, { recursive: true, force: true });
    fs.cpSync(staged, bundle, { recursive: true });
  });
}
