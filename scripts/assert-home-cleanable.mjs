#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const homes = process.argv.slice(2);
if (homes.length === 0) {
  console.error("usage: assert-home-cleanable.mjs <DOMO_HOME> [...]");
  process.exit(2);
}

const present = (value) =>
  (typeof value === "string" && value.trim() !== "") ||
  (Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim() !== ""));

for (const home of homes) {
  const file = path.join(home, "app/settings.json");
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    console.error(`error: refusing to clean ${home}: settings are unreadable`);
    process.exit(1);
  }
  const blocked = [
    "relayCredential",
    "relayCredentialEnc",
    "pendingRevokeCredentials",
    "pendingRevokeCredentialsEnc",
  ].some((field) => present(settings?.[field]));
  if (blocked) {
    console.error(`error: refusing to clean ${home}: sign out and wait for pending revokes to reach zero`);
    process.exit(1);
  }
}
