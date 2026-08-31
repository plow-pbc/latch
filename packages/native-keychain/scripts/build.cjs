// Build the addon, tolerantly. The Keychain provider is one of three the key
// store can use, so a machine that cannot compile it (no Xcode CLT, CI on
// Linux) must still be able to `just install` — the store falls back to
// safeStorage or the key file. A real build failure is printed, not hidden.
"use strict";
const { spawnSync } = require("node:child_process");

if (process.platform !== "darwin") {
  console.log("@domo/native-keychain: not macOS, skipping build");
  process.exit(0);
}

const result = spawnSync("npx", ["node-gyp", "rebuild"], {
  cwd: __dirname + "/..",
  stdio: "inherit",
});

if (result.status !== 0) {
  console.warn(
    "@domo/native-keychain: build failed (see above). " +
      "The vault falls back to safeStorage/file for its master key; " +
      "install the Xcode command line tools and `npm rebuild @domo/native-keychain` to enable SecItem.",
  );
}
process.exit(0);
