// Build the addon, tolerantly — the same posture as @domo/native-keychain.
// Credential exchange is an optional convenience (macOS 26+, packaged builds
// only), so a machine that cannot compile it (no Xcode CLT, CI on Linux) must
// still be able to `just install`; the app then simply cannot receive an
// export from Apple Passwords. A real build failure is printed, not hidden.
"use strict";
const { spawnSync } = require("node:child_process");

if (process.platform !== "darwin") {
  console.log("@domo/native-credential-import: not macOS, skipping build");
  process.exit(0);
}

const result = spawnSync("npx", ["node-gyp", "rebuild"], {
  cwd: __dirname + "/..",
  stdio: "inherit",
});

if (result.status !== 0) {
  console.warn(
    "@domo/native-credential-import: build failed (see above). " +
      "Receiving passwords from Apple Passwords will be unavailable; " +
      "install the Xcode command line tools and `npm rebuild @domo/native-credential-import` to enable it.",
  );
}
process.exit(0);
