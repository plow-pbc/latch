// Loader for the compiled addon. CommonJS so it can be pulled in with
// createRequire from ESM (the pattern @domo/native-keychain set). Returns null
// rather than throwing when the addon was never built — the desktop app treats
// that as "this build cannot receive a credential exchange".
"use strict";
const path = require("node:path");

let addon = null;
try {
  if (process.platform === "darwin") {
    addon = require(path.join(__dirname, "build", "Release", "credential_import.node"));
  }
} catch {
  addon = null;
}

module.exports = addon;
