// Forget when the Capabilities banner was last dismissed (and any per-row
// "not now"), so every block in the audit log counts again — the banner,
// the rows' lines, the badge. Nothing else in settings.json is touched.
//
// Usage: node scripts/reset-blocked-banner.mjs <apphome>
import fs from "node:fs";
import path from "node:path";

const home = process.argv[2];
if (!home) {
  console.error("usage: reset-blocked-banner.mjs <apphome>");
  process.exit(2);
}
const file = path.join(home, "app", "settings.json");
if (!fs.existsSync(file)) {
  console.log(`no settings at ${file}; nothing to reset`);
  process.exit(0);
}
const settings = JSON.parse(fs.readFileSync(file, "utf8"));
const had = settings.blockedBannerSeenAt ?? null;
delete settings.blockedBannerSeenAt;
delete settings.capabilityDismissals;
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
console.log(had ? `forgot the banner's dismissal at ${had}` : "the banner had never been dismissed");
console.log("Refocus the app or open the Capabilities tab; no relaunch needed.");
