// Give the dev Electron bundle the usage strings the packaged app carries.
//
// A from-source `just app` runs node_modules/electron's stock Electron.app.
// The Contacts and Calendars request APIs (@domo/native-permissions) show a
// dialog only to a caller whose OWN bundle declares NSContactsUsageDescription
// and NSCalendarsFullAccessUsageDescription; the packaged app declares them
// through electron-builder's extendInfo, the stock bundle does not, and
// without them macOS refuses the request on the spot. So this adds the same
// keys to the dev bundle's Info.plist and re-seals it ad hoc (the bundle is
// ad-hoc signed already; editing the plist breaks the seal, and macOS is
// stricter with an unsealed bundle than with an ad-hoc one).
//
// Idempotent, and a `just build` step: `npm install` restores the stock
// bundle, and the next build patches it again. Nothing here touches the
// packaged app. Non-Mac hosts, or a checkout with no Electron, skip.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

if (process.platform !== "darwin") process.exit(0);

let electronBinary;
try {
  // node_modules/electron's export is the path to the Electron binary inside
  // the .app; the bundle is three directories up from it.
  electronBinary = createRequire(path.join(dir, "..", "package.json"))("electron");
} catch {
  console.log("dev-usage-strings: no electron in node_modules; skipping");
  process.exit(0);
}
const bundle = electronBinary.replace(/\/Contents\/MacOS\/.*$/, "");
const plist = path.join(bundle, "Contents", "Info.plist");
if (!bundle.endsWith(".app") || !fs.existsSync(plist)) {
  console.log(`dev-usage-strings: ${bundle} is not an app bundle; skipping`);
  process.exit(0);
}

// The same strings electron-builder.yml declares for the packaged app.
const STRINGS = {
  NSContactsUsageDescription: "Plow Latch reads and updates your contacts only for requests you approve.",
  NSCalendarsUsageDescription: "Plow Latch reads your calendars only for requests you approve.",
  NSCalendarsFullAccessUsageDescription: "Plow Latch reads your calendars only for requests you approve.",
};

const plistBuddy = "/usr/libexec/PlistBuddy";
const read = (key) => {
  try {
    return execFileSync(plistBuddy, ["-c", `Print :${key}`, plist], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
let changed = false;
for (const [key, value] of Object.entries(STRINGS)) {
  if (read(key) === value) continue;
  const op = read(key) === null ? "Add" : "Set";
  execFileSync(plistBuddy, ["-c", op === "Add" ? `Add :${key} string ${value}` : `Set :${key} ${value}`, plist]);
  changed = true;
}
if (!changed) {
  console.log(`dev-usage-strings: ${path.basename(bundle)} already carries the usage strings`);
  process.exit(0);
}
// Re-seal, ad hoc and deep: the plist is part of what the seal covers.
execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "ignore" });
console.log(`dev-usage-strings: added Contacts/Calendars usage strings to ${path.basename(bundle)} and re-sealed it`);
