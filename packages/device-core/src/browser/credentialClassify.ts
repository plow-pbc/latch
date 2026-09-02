/**
 * Which fields a vault item has, which of them the vault conceals, and what a
 * label releases — the credential broker's whole policy, as pure functions.
 *
 * This is a line-for-line port of the classifier that lived in the vendored
 * Python broker (seed_vault_broker/cli.py), kept faithful because the
 * cross-language truth table in fixtures/maskClassification.json freezes its
 * behavior — maskClassification.test.ts drives THIS code over that table.
 * The shapes and concealment rules come from the pinned Bitwarden client
 * source the fixture's header cites; the comments explaining each decision
 * moved here with the code they explain.
 *
 * Values appear only in readField's return; descriptors and labels never
 * carry one.
 */
import { RawItem } from "./vaultItems.js";
import { expiryIso } from "./dateFormat.js";

const FIELD_PASSWORD = "password";
const FIELD_TOTP = "totp";
const FIELD_USERNAME = "username";
export const USERNAME_FIELDS = new Set([FIELD_USERNAME, "email", "login", "user"]);

// A card is only useful if its parts can actually be released: the item is
// already exempt from the site check on purpose (a card is meant for any
// merchant). `cvv` and `expiry` are what checkout forms call them; the vault
// calls them `code` and `expMonth`/`expYear`.
const CARD_FIELDS: Record<string, string> = {
  "number": "number",
  "code": "code",
  "cvv": "code",
  "security code": "code",
  "expiry month": "expMonth",
  "expiry year": "expYear",
  "cardholder name": "cardholderName",
  "brand": "brand",
};

// An identity item, by the label each part is released under. The order is the
// order they are reported in; the keys are the vault's own. birthDate is not
// Bitwarden's — it is this app's own, kept ISO so a fill can reshape it.

/** This app's one extension of the pinned identity shape: ISO YYYY-MM-DD. */
export const DATE_OF_BIRTH = "date of birth";

const IDENTITY_FIELDS: Record<string, string> = {
  "title": "title",
  "first name": "firstName",
  "middle name": "middleName",
  "last name": "lastName",
  "username": "username",
  "company": "company",
  "ssn": "ssn",
  "passport number": "passportNumber",
  "license number": "licenseNumber",
  "email": "email",
  "phone": "phone",
  "address1": "address1",
  "address2": "address2",
  "address3": "address3",
  "city": "city",
  "state": "state",
  "postal code": "postalCode",
  "country": "country",
  [DATE_OF_BIRTH]: "birthDate",
};

/** A card's expiry as one date, composed at release from expMonth/expYear
 * (YYYY-MM). Listed, unlike full name: forms want it as one field far more
 * often than as two, and a format reshapes it. */
export const CARD_EXPIRY = "expiry";

/** The labels a fill may reshape with a format: the shape typed when no
 * format is given, and a sample value the pattern is checked against
 * before the vault is asked. */
export const DATE_LABELS: Record<string, { shape: string; sample: string }> = {
  [DATE_OF_BIRTH]: { shape: "YYYY-MM-DD", sample: "2000-01-01" },
  [CARD_EXPIRY]: { shape: "MM/YY", sample: "2000-01" },
};

// What the client conceals on an identity, and all it conceals. A licence
// number is shown, as is every name, address and contact part — which is the
// point, because verifying a shipping address before submitting a form is work
// the agent has to do.
const HIDDEN_IDENTITY_LABELS = new Set(["ssn", "passport number"]);

// An identity's full name is not stored; the client composes it from the title
// and the three name parts and offers it as something a linked field can point
// at. Releasable for that reason, and for that reason only — it is not one of
// the item's own fields, so it is not listed as one.
const FULL_NAME = "full name";

// An SSH key item. The client shows the private key in a password box with a
// reveal toggle and the other two as plain text, so the private key is the one
// part concealed.
const SSH_KEY_FIELDS: Record<string, string> = {
  "private key": "privateKey",
  "public key": "publicKey",
  "fingerprint": "keyFingerprint",
};
const HIDDEN_SSH_KEY_LABELS = new Set(["private key"]);

// Bitwarden custom field types: 0 text, 1 hidden, 2 boolean, 3 linked.
const CUSTOM_FIELD_HIDDEN = 1;
const CUSTOM_FIELD_LINKED = 3;

// What a linked custom field can point at, by the label this broker releases
// the target under. The numbers are Bitwarden's own.
const LINKED_ID_LABELS: Record<number, string> = {
  100: FIELD_USERNAME, 101: FIELD_PASSWORD,
  300: "cardholder name", 301: "expiry month", 302: "expiry year",
  303: "code", 304: "brand", 305: "number",
  400: "title", 401: "middle name", 402: "address1", 403: "address2",
  404: "address3", 405: "city", 406: "state", 407: "postal code",
  408: "country", 409: "company", 410: "email", 411: "phone", 412: "ssn",
  413: FIELD_USERNAME, 414: "passport number", 415: "license number",
  416: "first name", 417: "last name", 418: FULL_NAME,
};

// Which fields the vault itself renders masked — very nearly the whole
// classification, and the reason there is little bespoke to maintain: the
// vault (and thereby the human who made the item) already decided.
//
// The ONE exception, deliberate and the only one: a generated TOTP code is
// masked although the client shows it. The client shows it because a person
// has to read it off the screen; an agent fills it and moves on.
const HIDDEN_CARD_LABELS = new Set(["number", "code"]);

// How a custom field is named when a fixed slot already owns its name.
const CUSTOM_PREFIX = "custom:";

// Vault item types mapped onto the category names the browser side speaks.
export const CATEGORY_BY_TYPE: Record<number, string> = {
  1: "LOGIN",
  2: "SECURE_NOTE",
  3: "CREDIT_CARD",
  4: "IDENTITY",
  5: "SSH_KEY",
};

export function categoryOf(item: RawItem): string {
  return CATEGORY_BY_TYPE[item.type] ?? "UNKNOWN";
}

export interface FieldDescriptor {
  label: string;
  hidden: boolean;
  custom: boolean;
  alias: boolean;
}

/**
 * The other names `get-field` takes for a built-in slot. Derived from the two
 * tables that already define them rather than a third list that could drift
 * from either. A custom field is named by whoever made it and has no aliases.
 */
function aliasesOf(label: string, custom: boolean): string[] {
  if (custom) return [];
  if (label === FIELD_USERNAME) {
    return [...USERNAME_FIELDS].filter((f) => f !== FIELD_USERNAME).sort();
  }
  const slot = CARD_FIELDS[label];
  if (slot === undefined) return [];
  return Object.entries(CARD_FIELDS)
    .filter(([alias, key]) => key === slot && alias !== label)
    .map(([alias]) => alias)
    .sort();
}

/**
 * The token `get-field` takes for one custom field: its own name, except when
 * a fixed slot has already claimed that name — a custom field literally called
 * `cardholder name` on a card. Describing both under one token left the custom
 * one impossible to ASK for, because the slot answers first; qualifying the
 * second one gives it a name of its own.
 */
function customLabel(name: string, soFar: FieldDescriptor[]): string {
  return soFar.some((d) => d.label === name && !d.custom) ? `${CUSTOM_PREFIX}${name}` : name;
}

/**
 * What this item actually has, by label, so the agent can match the form.
 * Entries marked `alias` are alternative names `get-field` accepts for a slot
 * already listed. Each entry also says whether the vault renders that field
 * masked. Values are never in here.
 */
export function fieldDescriptors(item: RawItem): FieldDescriptor[] {
  const isCard = categoryOf(item) === "CREDIT_CARD";
  const out: FieldDescriptor[] = [];

  const add = (label: string, hidden: boolean, custom: boolean, aliases = true): void => {
    out.push({ label, hidden, custom, alias: false });
    if (!aliases) return; // an identity's own username/email are separate parts, not two names for one slot
    for (const alias of aliasesOf(label, custom)) {
      out.push({ label: alias, hidden, custom: false, alias: true });
    }
  };

  const login = item.login ?? {};
  if (login.username) add(FIELD_USERNAME, false, false);
  if (login.password) add(FIELD_PASSWORD, true, false);
  // The one place this masks something the client shows: see the header note.
  if (login.totp) add(FIELD_TOTP, true, false);

  const card = item.card ?? {};
  for (const [key, label] of [
    ["number", "number"], ["code", "code"],
    ["expMonth", "expiry month"], ["expYear", "expiry year"],
    ["cardholderName", "cardholder name"], ["brand", "brand"],
  ] as const) {
    if (card[key]) add(label, isCard && HIDDEN_CARD_LABELS.has(label), false);
  }
  if (expiryIso(card.expMonth, card.expYear) !== null) add(CARD_EXPIRY, false, false, false);

  const identity = item.identity;
  if (identity) {
    // Driven by what the item actually holds. A key outside this list is NOT
    // reported and NOT released: whether a field is concealed is the vault's
    // answer to give, and for a key the pinned client does not define there is
    // no answer to read — so this refuses rather than inventing a
    // classification. Reporting it masked would be the same guess wearing a
    // safer-looking hat.
    for (const [label, key] of Object.entries(IDENTITY_FIELDS)) {
      if (identity[key]) add(label, HIDDEN_IDENTITY_LABELS.has(label), false, false);
    }
  }

  const sshKey = item.sshKey ?? {};
  for (const [label, key] of Object.entries(SSH_KEY_FIELDS)) {
    if (sshKey[key]) add(label, HIDDEN_SSH_KEY_LABELS.has(label), false, false);
  }

  for (const field of item.fields ?? []) {
    const name = field.name;
    if (!name) continue;
    if (field.type === CUSTOM_FIELD_LINKED) {
      // A linked field holds no value of its own: it names another field of
      // the same item. It is as concealed as whatever it points at — pointing
      // at a password does not make it safe to show — and its name is
      // qualified against slot collisions like any other custom field's.
      const target = field.linkedId != null ? LINKED_ID_LABELS[field.linkedId] : undefined;
      if (target !== undefined && readSlot(item, target) !== null) {
        const hidden = out.find((d) => d.label === target && !d.custom)?.hidden ?? false;
        add(customLabel(name, out), hidden, true, false);
      }
      continue;
    }
    if (field.value !== undefined || field.type === CUSTOM_FIELD_HIDDEN) {
      add(customLabel(name, out), field.type === CUSTOM_FIELD_HIDDEN, true);
    }
  }
  if (item.notes) add("notes", false, false);

  // A token has to name ONE field. Two custom fields with the same name —
  // which, when a fixed slot owns that name too, both qualify to the same
  // `custom:` token — name neither, so both are dropped: whichever one order
  // happened to favour would be a guess, and this refuses instead of guessing.
  const seen = new Map<string, number>();
  for (const d of out) seen.set(d.label, (seen.get(d.label) ?? 0) + 1);
  return out.filter((d) => seen.get(d.label) === 1);
}

/** Just the labels, in order — what the "it has:" error message is written
 * against. Deduped, because a custom field sharing a built-in's name is one
 * releasable token, not two. */
export function fieldLabels(item: RawItem): string[] {
  const labels: string[] = [];
  for (const d of fieldDescriptors(item)) {
    if (d.alias) continue;
    if (!labels.includes(d.label)) labels.push(d.label);
  }
  return labels;
}

const text = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);

/**
 * The value of one of the item's own fixed slots — never a custom field.
 *
 * What a linked field points at is a slot, by number, out of Bitwarden's own
 * enum. Resolving one through the ordinary lookup let it fall through an empty
 * slot into a custom field that happened to share the name, and a Hidden one
 * at that. A link resolves here or not at all.
 */
export function readSlot(item: RawItem, label: string): string | null {
  const login = item.login ?? {};
  if (label === FIELD_PASSWORD) return text(login.password);
  if (USERNAME_FIELDS.has(label) && text(login.username) !== null) return text(login.username);
  const cardKey = CARD_FIELDS[label];
  if (cardKey !== undefined) return text((item.card ?? {})[cardKey]);
  if (label === CARD_EXPIRY) return expiryIso((item.card ?? {}).expMonth, (item.card ?? {}).expYear);
  const identity = item.identity ?? {};
  const identityKey = IDENTITY_FIELDS[label];
  if (identityKey !== undefined) return text(identity[identityKey]);
  if (label === FULL_NAME) {
    const joined = ["title", "firstName", "middleName", "lastName"]
      .map((k) => (identity[k] ?? "").trim())
      .filter(Boolean)
      .join(" ");
    return joined || null;
  }
  const sshKeyField = SSH_KEY_FIELDS[label];
  if (sshKeyField !== undefined) return text((item.sshKey ?? {})[sshKeyField]);
  return null;
}

/**
 * The value behind one label. The item's own fixed slots answer first, through
 * the same resolution a linked field uses. Everything a slot cannot answer is
 * the note body or a custom field, and a name held by more than one custom
 * field names none of them (see fieldDescriptors, which drops the ambiguous
 * token rather than picking by order).
 */
export function readField(item: RawItem, field: string): string | null {
  const slot = readSlot(item, field);
  if (slot !== null) return slot;
  if (field === "notes" && item.notes) return item.notes;

  const customs = item.fields ?? [];
  // An exact name always wins, so a custom field genuinely called
  // "custom:something" is still reachable; only then is the qualifier peeled
  // off and the name behind it looked up.
  const wanteds = [field, field.startsWith(CUSTOM_PREFIX) ? field.slice(CUSTOM_PREFIX.length) : null];
  for (const wanted of wanteds) {
    if (wanted === null) continue;
    const matches = customs.filter((c) => c.name === wanted);
    if (matches.length > 1) return null;
    if (matches.length === 1) {
      const custom = matches[0];
      if (custom.type === CUSTOM_FIELD_LINKED) {
        const target = custom.linkedId != null ? LINKED_ID_LABELS[custom.linkedId] : undefined;
        return target !== undefined ? readSlot(item, target) : null;
      }
      return text(custom.value);
    }
  }
  return null;
}

export { FIELD_TOTP };
