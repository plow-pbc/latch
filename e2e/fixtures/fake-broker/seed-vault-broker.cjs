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
 * A field value may instead be an object carrying what the real vault stores
 * alongside the value, so describe-item can report the same `hidden` flag the
 * real broker derives:
 *   "fields": { "recovery": { "value": "...", "custom": true, "type": 1 } }
 * `custom` marks a named custom field rather than a built-in slot; `type` is
 * Bitwarden's custom field type (1 = Hidden).
 *
 * A field may instead be LINKED: { "name": "my ssn", "linked": "ssn" } holds no
 * value of its own and hands over the field it names, concealed exactly as that
 * field is.
 *
 * `fields` may also be an ARRAY of { name, value, custom, type }. A real item
 * can carry a custom field whose name is exactly a built-in's — a custom
 * "cardholder name" on a card — and an object keyed by label cannot hold the
 * two of them, which is the only reason this form exists.
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

// Which built-in labels the vault renders masked, keyed the way the real broker
// keys them: the card aliases all denote the same two card slots.
const CARD_FIELD_KEY = {
  number: "number",
  code: "code",
  cvv: "code",
  "security code": "code",
  "expiry month": "expMonth",
  "expiry year": "expYear",
  "cardholder name": "cardholderName",
};
const HIDDEN_CARD_KEYS = new Set(["number", "code"]);
// All the client conceals on an identity. Names, addresses and contact parts
// stay visible on purpose — the agent has to be able to verify them.
const HIDDEN_IDENTITY_LABELS = new Set(["ssn", "passport number"]);
// Every part of an identity the broker knows a label for. A key outside this
// set is not reported and not releasable, exactly as in the real broker: what
// is concealed is Bitwarden's answer to give, and there is no answer to read
// for a key its client does not define.
const KNOWN_IDENTITY_LABELS = new Set([
  "title", "first name", "middle name", "last name", "username", "company",
  "ssn", "passport number", "license number", "email", "phone",
  "address1", "address2", "address3", "city", "state", "postal code", "country",
]);
// An SSH key: the client conceals the private key and shows the other two.
const HIDDEN_SSH_KEY_LABELS = new Set(["private key"]);

/** Every field of an item, in order, in one shape whichever form was written. */
function specs(item) {
  const fields = item.fields || {};
  const all = Array.isArray(fields)
    ? fields.map((f) => ({ ...f, label: f.name }))
    : Object.keys(fields).map((label) => {
        const raw = fields[label];
        return raw !== null && typeof raw === "object" ? { ...raw, label } : { label, value: raw };
      });
  if (item.category !== "IDENTITY") return all;
  // A part of an identity the broker has no label for is not a field it knows
  // about: it is neither described nor released. A custom or linked field on an
  // identity is still the human's own and keeps its name.
  return all.filter(
    (s) =>
      KNOWN_IDENTITY_LABELS.has(s.label) || s.custom === true || s.linked !== undefined,
  );
}

/** The other names get-field takes for a built-in slot, as the real broker
 * derives them from _USERNAME_FIELDS and _CARD_FIELDS. */
function aliasesOf(item, label, custom) {
  if (custom) return [];
  // An identity's own username and email are two parts of one item, not two
  // names for one slot.
  if (item.category === "IDENTITY" || item.category === "SSH_KEY") return [];
  if (label === "username") return ["email", "login", "user"].sort();
  const slot = CARD_FIELD_KEY[label];
  if (!slot) return [];
  return Object.keys(CARD_FIELD_KEY)
    .filter((a) => CARD_FIELD_KEY[a] === slot && a !== label)
    .sort();
}

/** Whether one field of one item is concealed, as the real broker decides it. */
function isHidden(item, s) {
  if (s.linked !== undefined) {
    // A linked field is as concealed as what it points at.
    return isHidden(item, { label: s.linked });
  }
  if (s.custom === true) return s.type === 1;
  if (s.label === "password") return true;
  if (item.category === "CREDIT_CARD") return HIDDEN_CARD_KEYS.has(CARD_FIELD_KEY[s.label]);
  if (item.category === "SSH_KEY") return HIDDEN_SSH_KEY_LABELS.has(s.label);
  if (item.category === "IDENTITY") return HIDDEN_IDENTITY_LABELS.has(s.label);
  return false;
}

/** How a custom field is named when a fixed slot already claimed its name. */
const CUSTOM_PREFIX = "custom:";

/** The §3.1 classification, as the real broker derives it from the vault item. */
function describeField(item, s, soFar) {
  const custom = s.custom === true || s.linked !== undefined;
  const hidden = isHidden(item, s);
  // A colliding custom field is qualified so it can be asked for at all; every
  // token that did not collide is untouched. A LINKED field is a custom field
  // for this purpose — its name can collide with a slot's exactly as any other
  // custom name can.
  const label =
    custom && soFar.some((d) => d.label === s.label && !d.custom)
      ? CUSTOM_PREFIX + s.label
      : s.label;
  return [
    { label, hidden, custom, alias: false },
    ...aliasesOf(item, label, custom).map((l) => ({ label: l, hidden, custom: false, alias: true })),
  ];
}

/** Every descriptor of one item, in order, qualifying collisions as it goes. */
function describeItem(item) {
  const out = [];
  for (const s of specs(item)) out.push(...describeField(item, s, out));
  return out;
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
  // The real broker writes this line for every describe, which is why callers
  // above care how often they ask. Same shape: labels, never a value.
  audit(id, "(labels)", "-", "DESCRIBED");
  process.stdout.write(
    JSON.stringify({
      id: item.id,
      title: item.title,
      category: item.category,
      fields: describeItem(item),
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
  // A built-in slot wins a name collision with a custom field, as it does in
  // the real broker's _read_field; an alias resolves to the slot it names.
  const canonical = item.category === "IDENTITY"
    ? field
    : { email: "username", login: "username", user: "username",
        cvv: "code", "security code": "code" }[field] ?? field;
  // An exact name wins, so a custom field genuinely called "custom:x" is still
  // reachable; only then is the qualifier peeled off, and then only a custom
  // field can answer.
  const exact = specs(item).filter((s) => s.label === field || s.label === canonical);
  const qualified = field.startsWith(CUSTOM_PREFIX)
    ? specs(item).filter(
        (s) => s.label === field.slice(CUSTOM_PREFIX.length) && (s.custom === true || s.linked !== undefined),
      )
    : [];
  const match = exact.length ? exact : qualified;
  const chosen = exact.length
    ? exact.find((s) => s.custom !== true && s.linked === undefined) ?? exact[0]
    : match[0] ?? {};
  // A linked field hands over whatever it points at.
  const value = chosen.linked !== undefined
    ? (specs(item).find((s) => s.label === chosen.linked) ?? {}).value
    : chosen.value;
  if (value === undefined) fail("OpNotFound", `no field ${field}`);
  audit(id, field, page || "SEM-URL", "RELEASED");
  process.stdout.write(value); // no trailing newline, like the real one
} else {
  fail("InvalidArgument", "unknown command: " + cmd);
}
