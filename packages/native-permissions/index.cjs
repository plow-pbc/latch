// Loader for the compiled addon. CommonJS so it can be pulled in with
// createRequire from ESM, like @domo/native-keychain. Null rather than a throw
// when the addon was never built: the Capabilities tab then asks for Contacts
// and Calendars through the pane instead of a dialog.
"use strict";
const path = require("node:path");

let addon = null;
try {
  if (process.platform === "darwin") {
    addon = require(path.join(__dirname, "build", "Release", "permissions.node"));
  }
} catch {
  addon = null;
}

module.exports = addon;
