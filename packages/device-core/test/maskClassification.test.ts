/**
 * The §3.1 masking rule, asserted against the classifier that implements it:
 * credentialClassify.ts, driven through the real broker (BrokerCore) over a
 * real encrypted store.
 *
 * This table was born as a cross-language contract: the classifier lived in
 * the vendored Python broker, and this file drove it through a probe. The
 * classifier is TypeScript now and there is exactly one of it, but the table
 * stays the spec — each case is one raw Bitwarden-shaped item and the
 * descriptors that must be derived from it. The cases are encrypted into a
 * real store here, so every assertion crosses the same path a live release
 * does: EncString → decryptRaw → classify → release.
 *
 * No field value is asserted on; the last test proves none come back for a
 * concealed field.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrokerCore,
  Cipher,
  CredentialError,
  CredentialFieldInfo,
  RawItem,
  VaultKeyStore,
  VaultStore,
  readField,
  splitKey,
} from "@domo/device-core";
import { encString } from "../src/browser/vaultCrypto.js";

const TABLE_PATH = fileURLToPath(
  new URL("../../../e2e/fixtures/maskClassification.json", import.meta.url),
);

interface Case {
  name: string;
  why: string;
  bitwarden: RawItem & { [k: string]: unknown };
  expect: CredentialFieldInfo[];
}

const CASES: Case[] = (JSON.parse(fs.readFileSync(TABLE_PATH, "utf8")) as { cases: Case[] }).cases;

/** Values planted in the table. Never asserted on — only searched for. */
const SECRETS = [
  "hunter2",
  "recovery-code-9f2a",
  "4111111111111111",
  "737",
  "the real one",
  "078-05-1120",
  "X1234567",
  "BEGIN OPENSSH PRIVATE KEY",
  "concealed-custom",
];

/**
 * Encrypt one raw fixture item into the store's Cipher shape, under the
 * account key. Hand-rolled rather than via encryptCipher, because the table
 * deliberately holds shapes this app's own forms refuse to write (SSH keys,
 * linked custom fields, passkeys) — the broker still has to classify them.
 */
function encryptRaw(raw: Case["bitwarden"], key: { enc: Buffer; mac: Buffer }): Cipher {
  const enc = (v: unknown): string | null =>
    typeof v === "string" && v !== "" ? encString(Buffer.from(v, "utf8"), key.enc, key.mac) : null;
  const encRecord = (rec: unknown): Record<string, string | null> | null => {
    if (!rec || typeof rec !== "object") return null;
    const out: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = enc(v);
    return out;
  };
  const cipher: Cipher = {
    id: raw.id,
    type: raw.type,
    name: enc(raw.name) ?? "",
    notes: enc(raw.notes),
    reprompt: 0,
    key: null,
  };
  if (raw.login) {
    cipher.login = {
      username: enc(raw.login.username),
      password: enc(raw.login.password),
      totp: enc(raw.login.totp),
      uris: (raw.login.uris ?? []).map((u) => ({ uri: enc(u.uri) })),
    };
  }
  cipher.card = encRecord(raw.card);
  cipher.identity = encRecord(raw.identity);
  (cipher as { sshKey?: unknown }).sshKey = encRecord(raw.sshKey);
  if (Array.isArray(raw.fields)) {
    (cipher as { fields?: unknown }).fields = raw.fields.map((f) => ({
      name: enc(f.name),
      value: enc(f.value),
      type: f.type,
      linkedId: f.linkedId ?? null,
    }));
  }
  return cipher;
}

/** What the old classify probe measured, per case, now computed through the
 * real broker: descriptors, releasability, and release coherence. */
interface Probed {
  descriptors: CredentialFieldInfo[];
  releasable: { [label: string]: boolean };
  release: { [label: string]: { answered: boolean; flagged: boolean; agrees: boolean } };
  released: { [label: string]: string | null };
  undescribedRefused: boolean;
  unknownKeyReadable: boolean;
}

let dir: string;
let broker: BrokerCore;
const probed: { [name: string]: Probed } = {};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mask-classify-"));
  const keyStore = new VaultKeyStore(dir, "mask-classify-test");
  const key = crypto.randomBytes(64);
  keyStore.writeKey(key);
  const store = new VaultStore(dir);
  store.replaceAll(CASES.map((c) => encryptRaw(c.bitwarden, splitKey(key))));
  broker = new BrokerCore({ dir, store, keyStore });

  for (const c of CASES) {
    const descriptors = broker.describeItem(c.bitwarden.id).fields;
    const release: Probed["release"] = {};
    const released: Probed["released"] = {};
    const releasable: Probed["releasable"] = {};
    for (const d of descriptors) {
      if (d.label === "totp") {
        // A TOTP release generates a code from the seed; whether the item HAS
        // a seed is the releasable question (the fixture seeds are not valid
        // otpauth keys, so the generated-code path is covered elsewhere:
        // vaultTotp.test.ts owns RFC 6238).
        releasable[d.label] = Boolean(c.bitwarden.login?.totp);
        continue;
      }
      let answer: { value: string; hidden: boolean } | null = null;
      try {
        answer = broker.getField(c.bitwarden.id, d.label);
      } catch {
        answer = null;
      }
      releasable[d.label] = answer !== null;
      release[d.label] = {
        answered: typeof answer?.value === "string",
        flagged: typeof answer?.hidden === "boolean",
        agrees: answer !== null && answer.hidden === d.hidden,
      };
      // The value itself, and ONLY for a field the vault does not conceal — a
      // masked value must not be able to reach this object whatever a test
      // asks for.
      if (answer && !d.hidden) released[d.label] = answer.value;
    }
    // A label the item can READ but does not OFFER must be refused. `full
    // name` is the live example: it exists so a linked field can point at it
    // and is deliberately not one of the item's own fields.
    let undescribedRefused = true;
    for (const label of ["full name"]) {
      if (descriptors.some((d) => d.label === label)) continue;
      if (readField(c.bitwarden, label) === null) continue;
      try {
        broker.getField(c.bitwarden.id, label);
        undescribedRefused = false;
      } catch (err) {
        if (!(err instanceof CredentialError)) undescribedRefused = false;
      }
    }
    probed[c.name] = {
      descriptors,
      releasable,
      release,
      released,
      undescribedRefused,
      // A key the pinned client does not define is refused, not released.
      unknownKeyReadable: readField(c.bitwarden, "middleInitial") !== null,
    };
  }
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const labelsOf = (name: string): string[] => {
  const seen: string[] = [];
  for (const d of probed[name].descriptors) {
    if (!d.alias && !seen.includes(d.label)) seen.push(d.label);
  }
  return seen;
};

describe("the classifier, through the real broker over a real store", () => {
  for (const c of CASES) {
    it(`classifies ${c.name} as the table says`, () => {
      expect(probed[c.name].descriptors).toEqual(c.expect);
    });
  }

  it("leaves the label list free of aliases, so the agent still sees the fields", () => {
    // The deduped label list is the "it has: ..." error text and the
    // releasable set; an alias is another name for a slot already there.
    expect(labelsOf("card with a colliding custom field")).toEqual([
      "number",
      "code",
      "expiry month",
      "expiry year",
      "cardholder name",
      "brand",
      "custom:cardholder name",
      "custom:number",
    ]);
  });

  it("gives a colliding custom field a token of its own, so it can be asked for", () => {
    // Sharing the built-in's name left the custom field describable but
    // impossible to select: the slot answers `cardholder name` first, every
    // time. It now has its own token, and the built-in's is untouched.
    const collision = probed["card with a colliding custom field"];
    expect(collision.descriptors.filter((d) => d.label.endsWith("cardholder name"))).toEqual([
      { label: "cardholder name", hidden: false, custom: false, alias: false },
      { label: "custom:cardholder name", hidden: false, custom: true, alias: false },
    ]);
    // Both are releasable, and they are different fields.
    expect(collision.releasable["cardholder name"]).toBe(true);
    expect(collision.releasable["custom:cardholder name"]).toBe(true);
    expect(collision.released["cardholder name"]).not.toBe(
      collision.released["custom:cardholder name"],
    );
  });

  it("gives a colliding LINKED field a token of its own as well", () => {
    // A linked field is a custom field for naming purposes. Without this it was
    // described and unaskable: `get-field number` reaches the card's own slot
    // every time, so the linked one had no way to be selected at all.
    const collision = probed["card with a colliding custom field"];
    expect(collision.descriptors.filter((d) => d.label.endsWith("number"))).toEqual([
      { label: "number", hidden: true, custom: false, alias: false },
      { label: "custom:number", hidden: true, custom: true, alias: false },
    ]);
    expect(collision.releasable["custom:number"]).toBe(true);
    // It inherits the concealment of what it points at, so neither value is in
    // `released` to compare — the flag is the assertion.
    expect(collision.descriptors.find((d) => d.label === "custom:number")?.hidden).toBe(true);
  });

  it("leaves an uncolliding custom field's token alone", () => {
    // Qualifying every custom field would have broken every token an agent
    // already knows; only the colliding one is renamed.
    const labels = probed["login"].descriptors.map((d) => d.label);
    expect(labels).toContain("recovery");
    expect(labels).toContain("account nickname");
    expect(labels.filter((l) => l.startsWith("custom:"))).toEqual([]);
  });

  for (const c of CASES) {
    it(`releases every field it lists for ${c.name}`, () => {
      // Listing a field the broker will not hand over is the shape of the gap
      // identity items were in: describe advertised nothing, get-field had
      // nothing to give. Every descriptor must answer, aliases included.
      const unreleasable = Object.entries(probed[c.name].releasable)
        .filter(([, ok]) => !ok)
        .map(([label]) => label);
      expect(unreleasable).toEqual([]);
      // Every distinct label is accounted for. A colliding pair is one label
      // and one release token, so distinct labels — not descriptors — is what
      // this counts.
      expect(Object.keys(probed[c.name].releasable).sort()).toEqual(
        [...new Set(c.expect.map((d) => d.label))].sort(),
      );
    });
  }

  it("refuses an identity key it has no label for, rather than guessing", () => {
    // Classifying it either way would be this side inventing an answer only
    // Bitwarden gets to give, so it is not offered at all — and what is not
    // offered cannot be filled.
    const identity = probed["identity"];
    expect(identity.descriptors.find((d) => d.label === "middleInitial")).toBeUndefined();
    expect(labelsOf("identity")).not.toContain("middleInitial");
    // Not listed and not readable: an unknown key is refused, not released
    // under a guessed flag.
    expect(identity.unknownKeyReadable).toBe(false);
  });

  it("does not list a passkey — it is not fillable text", () => {
    // Absence is invisible in a table, so it is stated.
    const labels = probed["login with a passkey"].descriptors.map((d) => d.label).join(" ");
    for (const term of ["passkey", "fido2", "credential", "keyvalue", "rpid"]) {
      expect(labels.toLowerCase()).not.toContain(term);
    }
  });

  it("composes a linked full name the way the client composes it", () => {
    // Built from the fixture rather than written out, so the rule is asserted
    // (title, first, middle, last, single-spaced, trimmed) and not a literal.
    const identity = CASES.find((c) => c.name === "identity with linked custom fields")!
      .bitwarden.identity as { [k: string]: string };
    const expected = ["title", "firstName", "middleName", "lastName"]
      .map((k) => identity[k])
      .filter((part) => part && part.trim())
      .join(" ");
    expect(probed["identity with linked custom fields"].released["who"]).toBe(expected);
  });

  for (const c of CASES) {
    it(`answers value and concealment in one release for ${c.name}`, () => {
      // The coherence property the design rests on: one call, one reading of
      // the item, both answers. Ask twice and an edit between the two releases
      // a concealed value under the flag the old one carried.
      for (const [label, shape] of Object.entries(probed[c.name].release)) {
        expect(shape.answered, `${label} answered`).toBe(true);
        expect(shape.flagged, `${label} carried a concealment flag`).toBe(true);
        expect(shape.agrees, `${label} agreed with its descriptor`).toBe(true);
      }
    });
  }

  it("resolves a link to a fixed slot or to nothing, never to a custom field", () => {
    // The link points at LoginLinkedId.Username on an item with no username
    // slot. Falling through to the Hidden custom field of that name would
    // release a concealed value under a flag read from the absent slot.
    const fell = probed["linked field pointing at an empty slot"];
    expect(fell.descriptors.map((d) => d.label)).not.toContain("who");
    expect(fell.releasable["who"]).toBeUndefined();
  });

  for (const c of CASES) {
    it(`refuses a label it can read but does not offer, for ${c.name}`, () => {
      // One resolution decides everything: a field with no descriptor has no
      // decision about whether it may be shown, so it is not released at all.
      expect(probed[c.name].undescribedRefused).toBe(true);
    });
  }

  it("returns no concealed field value for any item in the table", () => {
    const blob = JSON.stringify(
      Object.fromEntries(
        Object.entries(probed).map(([name, p]) => [name, { ...p, released: p.released }]),
      ),
    );
    for (const secret of SECRETS) expect(blob).not.toContain(secret);
  });
});
