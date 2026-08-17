#!/usr/bin/env node
/**
 * Fake seed-vault-broker for unit tests: speaks the same CLI surface
 * (whats-here / describe-item / get-field / status) and mimics the origin
 * check, backed by a JSON vault file. The REAL seed-vault-broker is
 * exercised in the integration tier against a fake `op` binary; this fake is
 * only for python-free unit tests of the TS layer above it.
 *
 * Vault file (env FAKE_BROKER_VAULT):
 *   [{ "id", "title", "category", "username", "urls": ["https://..."],
 *      "fields": { "password": "hunter2", ... } }]
 *
 * Like the real broker, appends release/denial lines (never values) to
 * SEED_VAULT_AUDIT when set.
 */
"use strict";
const fs = require("node:fs");
const pathmod = require("node:path");

function vault() {
  return JSON.parse(fs.readFileSync(process.env.FAKE_BROKER_VAULT, "utf8"));
}

function audit(itemId, field, page, outcome) {
  const file = process.env.SEED_VAULT_AUDIT;
  if (!file) return;
  fs.mkdirSync(pathmod.dirname(file), { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  fs.appendFileSync(file, `${stamp}  item=${itemId}  field=${field}  page=${page}  -> ${outcome}\n`);
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
  const item = vault().find((i) => i.id === id);
  if (!item) fail("VaultNotFound", "No such item in the vault.");
  const page = url ? hostKey(url) : null;
  if (url && item.category !== "CREDIT_CARD") {
    const keys = (item.urls || []).map(hostKey).filter(Boolean);
    if (keys.length && !keys.includes(page)) {
      audit(id, field, page, "DENIED origin mismatch");
      fail("VaultDenied", `item belongs to ${keys.join(", ")}, not to ${page}`);
    }
  }
  const value = (item.fields || {})[field];
  if (value === undefined) fail("OpNotFound", `no field ${field}`);
  audit(id, field, page || "SEM-URL", "RELEASED");
  process.stdout.write(value); // no trailing newline, like the real one
} else {
  fail("InvalidArgument", "unknown command: " + cmd);
}
