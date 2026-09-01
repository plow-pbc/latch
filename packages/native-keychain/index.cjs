// Loader for the compiled addon. CommonJS so it can be pulled in with
// createRequire from ESM (the pattern vaultSecretStore.ts already uses for
// Electron). Returns null rather than throwing when the addon was never
// built — the key store treats that as "this provider is not available".
"use strict";
const path = require("node:path");

let addon = null;
try {
  if (process.platform === "darwin") {
    addon = require(path.join(__dirname, "build", "Release", "keychain.node"));
  }
} catch {
  addon = null;
}

module.exports = addon;
