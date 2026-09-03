// Build the addon, tolerantly — the same contract as @domo/native-keychain's.
// A machine that cannot compile it (no Xcode CLT, CI on Linux) must still be
// able to `just install`; the app then has no in-process request and the
// Capabilities tab sends the owner to the pane. A real build failure is
// printed, not hidden.
"use strict";
const { spawnSync } = require("node:child_process");

if (process.platform !== "darwin") {
  console.log("@domo/native-permissions: not macOS, skipping build");
  process.exit(0);
}

const result = spawnSync("npx", ["node-gyp", "rebuild"], {
  cwd: __dirname + "/..",
  stdio: "inherit",
});

if (result.status !== 0) {
  console.warn(
    "@domo/native-permissions: build failed (see above). " +
      "Contacts and Calendars cannot be asked for from the Capabilities tab; " +
      "install the Xcode command line tools and `npm rebuild @domo/native-permissions` to enable it.",
  );
}
process.exit(0);
