/**
 * `describe-item` carries, per field, whether the vault itself masks it — the
 * classification the fill path needs to decide what may be shown back to the
 * agent. The vault is the authority: a login password and a card's number and
 * security code are hidden, a username, an expiry and a cardholder name are
 * not, and a custom field is hidden exactly when it is a Hidden custom field.
 *
 * No value of any field appears in an expectation here; only in the fixture the
 * fake vault is built from, and the last test asserts none of them come back.
 *
 * This file is about the TypeScript side of the seam: that the flag survives
 * transport and that a shape this side cannot read is dropped rather than
 * guessed. The classification RULE — including a custom field whose name is
 * byte-identical to a built-in's — is asserted against both the real and the
 * fake classifier in maskClassification.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialBroker, CredentialFieldInfo } from "@domo/device-core";

const FAKE_BROKER = fileURLToPath(
  new URL("../../../e2e/fixtures/fakeVaultBroker.cjs", import.meta.url),
);

/** The values the fake vault holds. Never asserted on — only searched for. */
const SECRETS = ["hunter2", "4111111111111111", "737", "recovery-code-9f2a"];

let dir: string;
let broker: CredentialBroker;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-fields-"));
  const vaultPath = path.join(dir, "vault.json");
  fs.writeFileSync(
    vaultPath,
    JSON.stringify([
      {
        id: "L1",
        title: "Pizza Login",
        category: "LOGIN",
        username: "jon",
        urls: ["https://pizza.example/login"],
        fields: {
          username: "jon",
          password: "hunter2",
          // A Hidden custom field, and a plain-text one beside it.
          recovery: { value: "recovery-code-9f2a", custom: true, type: 1 },
          "account nickname": { value: "the pizza one", custom: true, type: 0 },
        },
      },
      {
        id: "C1",
        title: "Visa",
        category: "CREDIT_CARD",
        username: "",
        urls: [],
        fields: {
          number: "4111111111111111",
          code: "737",
          "expiry month": "04",
          "expiry year": "2031",
          "cardholder name": "Jon Doe",
        },
      },
    ]),
  );
  broker = new CredentialBroker({
    command: [process.execPath, FAKE_BROKER],
    env: { FAKE_BROKER_VAULT: vaultPath },
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function byLabel(fields: CredentialFieldInfo[], label: string): CredentialFieldInfo | undefined {
  return fields.find((f) => f.label === label);
}

describe("describe-item field flags", () => {
  it("marks a login password hidden and its username visible", async () => {
    const { fields } = await broker.describeItem("L1");
    expect(byLabel(fields, "password")).toEqual({
      label: "password",
      hidden: true,
      custom: false,
      alias: false,
    });
    expect(byLabel(fields, "username")).toEqual({
      label: "username",
      hidden: false,
      custom: false,
      alias: false,
    });
  });

  it("marks a Hidden custom field hidden and a text custom field visible", async () => {
    const { fields } = await broker.describeItem("L1");
    expect(byLabel(fields, "recovery")).toEqual({
      label: "recovery",
      hidden: true,
      custom: true,
      alias: false,
    });
    expect(byLabel(fields, "account nickname")).toEqual({
      label: "account nickname",
      hidden: false,
      custom: true,
      alias: false,
    });
  });

  it("marks a card number and security code hidden, expiry and holder visible", async () => {
    const { fields } = await broker.describeItem("C1");
    expect(byLabel(fields, "number")?.hidden).toBe(true);
    expect(byLabel(fields, "code")?.hidden).toBe(true);
    expect(byLabel(fields, "expiry month")?.hidden).toBe(false);
    expect(byLabel(fields, "expiry year")?.hidden).toBe(false);
    expect(byLabel(fields, "cardholder name")?.hidden).toBe(false);
  });

  it("keeps a label that get-field accepts, and every field it reports", async () => {
    const { fields } = await broker.describeItem("C1");
    // The label is the release token, unchanged: what describe reports is what
    // get-field takes.
    const value = await broker.getField("C1", byLabel(fields, "number")!.label, "https://shop.example/pay");
    expect(value.length).toBeGreaterThan(0);
    expect(fields.filter((f) => !f.alias).map((f) => f.label).sort()).toEqual([
      "cardholder name",
      "code",
      "expiry month",
      "expiry year",
      "number",
    ]);
    // The aliases ride alongside, carrying the slot's own flag.
    expect(fields.filter((f) => f.alias)).toEqual([
      { label: "cvv", hidden: true, custom: false, alias: true },
      { label: "security code", hidden: true, custom: false, alias: true },
    ]);
  });

  it("drops an entry the broker did not describe as masked, rather than guessing", async () => {
    // A shape this side does not understand must not become hidden:false — that
    // is the mistake that puts a secret back on the agent's screen.
    const stray = path.join(dir, "stray.cjs");
    fs.writeFileSync(
      stray,
      'process.stdout.write(JSON.stringify({id:"S1",title:"t",category:"LOGIN",' +
        'fields:["password",{label:"code"},{label:"totp",hidden:false,custom:false}]}))\n',
    );
    const odd = new CredentialBroker({ command: [process.execPath, stray] });
    expect((await odd.describeItem("S1")).fields).toEqual([
      { label: "totp", hidden: false, custom: false, alias: false },
    ]);
  });

  it("returns no field value anywhere in a describe", async () => {
    for (const id of ["L1", "C1"]) {
      const described = JSON.stringify(await broker.describeItem(id));
      for (const secret of SECRETS) expect(described).not.toContain(secret);
    }
  });
});
