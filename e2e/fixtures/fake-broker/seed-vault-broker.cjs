#!/usr/bin/env node
/**
 * The one fake seed-vault-broker. It speaks the same CLI surface (whats-here /
 * describe-item / get-field / status), mimics the origin check, and appends the
 * same audit line, backed by a JSON vault file — so every test above the broker
 * runs against one description of the contract rather than a copy per tier.
 * Python-free by design: nothing here needs the real runtime.
 *
 * Vault file (env FAKE_BROKER_VAULT):
 *   [{ "id", "title", "category", "username", "urls": ["https://..."],
 *      "fields": { "password": "hunter2", ... } }]
 *
 * Two simplifications, deliberate: fields are a plain map, so the real broker's
 * card-label aliases (`cvv` → `code`) are written out in the fixture; and a
 * missing field is always `VaultNotFound`, where the real one distinguishes
 * "this item has no such label" (InvalidArgument) from "the label is empty".
 */
"use strict";
const fs = require("node:fs");

function vault() {
  return JSON.parse(fs.readFileSync(process.env.FAKE_BROKER_VAULT, "utf8"));
}

function hostKey(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function fail(type, message) {
  process.stderr.write(JSON.stringify({ type, message }) + "\n");
  process.exit(1);
}

/** What the real broker records: who, what, where, and how it ended — never the value. */
function audit(itemId, field, page, outcome) {
  if (!process.env.SEED_VAULT_AUDIT) return;
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " "); // as the real one writes it
  fs.appendFileSync(
    process.env.SEED_VAULT_AUDIT,
    `${stamp}  item=${itemId}  field=${field}  page=${page}  -> ${outcome}\n`,
    { mode: 0o600 },
  );
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "status") {
  process.stdout.write(JSON.stringify({ ok: true, signed_in: true }) + "\n");
} else if (cmd === "whats-here") {
  const url = argValue(args, "--url") ?? "";
  const page = hostKey(url);
  // A URL with no readable host is refused, not treated as "no URL given" —
  // otherwise a caller that hands over an about:/data:/blank page would sail
  // past the origin check here and be refused only by the real broker.
  if (url && !page) fail("InvalidArgument", `could not read a host from ${url}`);
  const out = vault().map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    username: item.username || "",
    urls: item.urls || [],
    matches_this_page: (item.urls || []).some((u) => hostKey(u) === page),
  }));
  process.stdout.write(JSON.stringify(out) + "\n");
} else if (cmd === "describe-item") {
  const id = argValue(args, "--item-id");
  const item = vault().find((i) => i.id === id);
  if (!item) fail("VaultNotFound", "No such item in the vault.");
  audit(id, "(labels)", "-", "DESCRIBED");
  process.stdout.write(
    JSON.stringify({
      id: item.id,
      title: item.title,
      category: item.category,
      fields: Object.keys(item.fields || {}),
    }) + "\n",
  );
} else if (cmd === "get-field") {
  const id = argValue(args, "--item-id");
  const field = argValue(args, "--field");
  const url = argValue(args, "--url");
  const page = url ? hostKey(url) : null;
  if (url && !page) fail("InvalidArgument", `could not read a host from ${url}`);
  const item = vault().find((i) => i.id === id);
  if (!item) fail("VaultNotFound", "No such item in the vault.");
  // Logins belong to their site; a login with no site at all belongs nowhere and
  // is refused. Cards and notes are not tied to a site and pass, as upstream.
  if (page && item.category === "LOGIN") {
    const keys = (item.urls || []).map(hostKey).filter(Boolean);
    if (!keys.length) {
      audit(id, field, page, "DENIED no site on item");
      fail("VaultDenied", `item is not tied to any site, so it cannot be released on ${page}`);
    }
    if (!keys.includes(page)) {
      audit(id, field, page, "DENIED origin mismatch");
      fail("VaultDenied", `item belongs to ${keys.join(", ")}, not to ${page}`);
    }
  }
  const value = (item.fields || {})[field];
  if (value === undefined) {
    audit(id, field, page || "SEM-URL", "ERROR VaultNotFound");
    fail("VaultNotFound", `no field ${field}`);
  }
  audit(id, field, page || "SEM-URL", "RELEASED");
  process.stdout.write(value); // no trailing newline, like the real one
} else {
  fail("InvalidArgument", "unknown command: " + cmd);
}
