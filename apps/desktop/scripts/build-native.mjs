// Compile the native helpers in native/ into dist/native/.
//
// Today that is one file: settings-window-frame.swift, the window tracker the
// Full Disk Access grant flow follows System Settings with (see
// src/permissionFlow.ts). Built universal (arm64 + x86_64, lipo-fused) so the
// binary is byte-identical in both of electron-builder's arch passes and the
// universal merge copies it through untouched — the python-runtime pattern,
// not the thin-per-arch providers one.
//
// A Mac without the Swift toolchain (no Xcode CLT) still builds and runs the
// app: this script warns and emits nothing, and the flow degrades to the
// fixed-position panel (fdaGrantFlow.ts handles the missing binary). The
// output directory is always created so electron-builder's extraResources
// entry never points at a missing source.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(dir, "../native/settings-window-frame.swift");
const outDir = path.join(dir, "../dist/native");
const output = path.join(outDir, "settings-window-frame");
const stampFile = `${output}.stamp`;

fs.mkdirSync(outDir, { recursive: true });

// Keyed on the source bytes: recompiling an unchanged helper on every build
// would put swiftc (~seconds) in the hot path of every `just build`.
const stamp = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
if (fs.existsSync(output) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === stamp) {
  console.log(`native helper up to date → ${output}`);
  process.exit(0);
}

let swiftc;
let sdk;
try {
  swiftc = execFileSync("xcrun", ["-f", "swiftc"], { encoding: "utf8" }).trim();
  // swiftc run outside of `xcrun` needs the SDK named explicitly, or it can't
  // find the standard library for an -target it wasn't launched under.
  sdk = execFileSync("xcrun", ["--show-sdk-path", "--sdk", "macosx"], { encoding: "utf8" }).trim();
} catch {
  console.warn(
    "build-native: swiftc not found (no Xcode command line tools) — " +
      "skipping settings-window-frame; the Full Disk Access panel will not follow System Settings",
  );
  process.exit(0);
}

const compile = (arch, out) =>
  execFileSync(swiftc, ["-O", "-sdk", sdk, "-target", `${arch}-apple-macos13.0`, source, "-o", out], {
    stdio: "inherit",
  });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "domo-native-"));
try {
  const slices = [];
  for (const arch of ["arm64", "x86_64"]) {
    const out = path.join(tmp, arch);
    try {
      compile(arch, out);
      slices.push(out);
    } catch (err) {
      // A toolchain that can't cross-compile still covers the host arch; a
      // host-arch failure is a real build error and stops the build.
      if (arch === (process.arch === "arm64" ? "arm64" : "x86_64")) throw err;
      console.warn(`build-native: ${arch} slice failed to build; emitting host-arch only`);
    }
  }
  if (slices.length > 1) {
    execFileSync("lipo", ["-create", ...slices, "-output", output], { stdio: "inherit" });
  } else {
    fs.copyFileSync(slices[0], output);
  }
  fs.chmodSync(output, 0o755);
  fs.writeFileSync(stampFile, stamp);
  console.log(`built native helper (${slices.length > 1 ? "universal" : "host arch"}) → ${output}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
