/**
 * The §3.1 masking rule, asserted against the classifier that implements it:
 * `seed_vault_broker/cli.py`.
 *
 * There used to be a second one — the JS fake carried its own copy of the rules
 * so the python-free tier had something to assert against, and this file
 * checked the two agreed. The fake now answers with whatever a fixture states,
 * so there is no second opinion to keep honest and nothing to compare. What is
 * left is the real classifier and the table it has to satisfy.
 *
 * The unit tier still needs no Python: this block skips when python3 is
 * missing. Where one exists — every dev Mac, since it ships with the OS — the
 * real classifier is executed.
 *
 * No field value is asserted on; the last test proves none come back.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CredentialFieldInfo } from "@domo/device-core";

const TABLE_PATH = fileURLToPath(
  new URL("../../../e2e/fixtures/maskClassification.json", import.meta.url),
);
const PROBE = fileURLToPath(new URL("../../../e2e/fixtures/classifyProbe.py", import.meta.url));
interface Case {
  name: string;
  why: string;
  bitwarden: { [k: string]: unknown };
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
];

function haveHost(bin: string): boolean {
  try {
    execFileSync(bin, ["-c", "pass"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAVE_PYTHON = haveHost("python3");

describe.skipIf(!HAVE_PYTHON)("the real classifier in cli.py", () => {
  const probed = (() => {
    const out = execFileSync("python3", [PROBE, TABLE_PATH], { encoding: "utf8" });
    return JSON.parse(out) as {
      [name: string]: {
        descriptors: CredentialFieldInfo[];
        labels: string[];
        releasable: { [label: string]: boolean };
        release: { [label: string]: { answered: boolean; flagged: boolean; agrees: boolean } };
        released: { [label: string]: string | null };
        unknownKeyReadable: boolean;
      };
    };
  })();

  for (const c of CASES) {
    it(`classifies ${c.name} as the table says`, () => {
      expect(probed[c.name].descriptors).toEqual(c.expect);
    });
  }

  it("leaves the label list free of aliases, so the agent still sees the fields", () => {
    // `_field_labels` is the "it has: ..." error text and the releasable set;
    // an alias is another name for a slot already there, not another field.
    expect(probed["card with a colliding custom field"].labels).toEqual([
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
    expect(identity.labels).not.toContain("middleInitial");
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

  it("reports nothing for an item type the vault cannot store", () => {
    // Not an oversight and not a gap to close here: vaultwarden 1.37.1 rejects
    // types 6-8 on every write path (src/api/core/ciphers.rs:508-515), so one
    // cannot reach the broker to be classified. Pinned so that whoever upgrades
    // the vault finds these cases waiting.
    for (const name of [
      "bank account (type the vault cannot store)",
      "driving licence (type the vault cannot store)",
      "passport (type the vault cannot store)",
    ]) {
      expect(probed[name].descriptors).toEqual([]);
      expect(probed[name].labels).toEqual([]);
    }
  });

  for (const c of CASES) {
    it(`answers value and concealment in one release for ${c.name}`, () => {
      // The coherence property the design rests on: one command, one reading of
      // the item, both answers. Ask twice and an edit between the two releases a
      // concealed value under the flag the old one carried.
      const shapes = Object.entries(probed[c.name].release);
      for (const [label, shape] of shapes) {
        expect(shape.answered, `${label} answered`).toBe(true);
        expect(shape.flagged, `${label} carried a concealment flag`).toBe(true);
        expect(shape.agrees, `${label} agreed with its descriptor`).toBe(true);
      }
    });
  }

  it("answers for every case in the table", () => {
    expect(Object.keys(probed).sort()).toEqual(CASES.map((c) => c.name).sort());
  });

  it("returns no field value for any item in the table", () => {
    const blob = JSON.stringify(probed);
    for (const secret of SECRETS) expect(blob).not.toContain(secret);
  });
});

it("says so rather than passing quietly when python3 is absent", () => {
  // Not a skip: the suite must be honest about which classifier it just checked.
  if (!HAVE_PYTHON) {
    console.warn("[maskClassification] no python3 — cli.py's classifier was NOT executed");
  }
  expect(CASES.length).toBeGreaterThan(0);
});
