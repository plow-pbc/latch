/**
 * The TypeScript side of the describe-item seam: that a field's `hidden` flag
 * survives transport intact, and that a shape this side cannot read is dropped
 * rather than guessed at.
 *
 * What the flag SHOULD be for a given item is not asserted here — that is the
 * classifier's business and is tested against the real one in
 * maskClassification.test.ts. The fake broker answers with whatever a fixture
 * states, so asking it about classification would only assert the fixture
 * against itself.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialBroker } from "@domo/device-core";

const FAKE_BROKER = fileURLToPath(
  new URL("../../../e2e/fixtures/fakeVaultBroker.cjs", import.meta.url),
);

/** The value the fake vault holds. Never asserted on — only searched for. */
const SECRET = "hunter2";

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
        descriptors: [
          { label: "username", hidden: false, custom: false, alias: false },
          { label: "password", hidden: true, custom: false, alias: false },
          { label: "email", hidden: false, custom: false, alias: true },
        ],
        values: { username: "jon", password: SECRET, email: "jon" },
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

describe("describe-item across the seam", () => {
  it("carries every flag through unchanged", async () => {
    const { fields } = await broker.describeItem("L1");
    expect(fields).toEqual([
      { label: "username", hidden: false, custom: false, alias: false },
      { label: "password", hidden: true, custom: false, alias: false },
      { label: "email", hidden: false, custom: false, alias: true },
    ]);
  });

  it("drops an entry it cannot read, rather than guessing", async () => {
    // A shape this side does not understand must not become hidden:false —
    // that is the mistake that puts a secret back on the agent's screen.
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

  it("returns no field value in a describe", async () => {
    expect(JSON.stringify(await broker.describeItem("L1"))).not.toContain(SECRET);
  });
});

describe("get-field across the seam", () => {
  it("carries the value and its concealment together", async () => {
    const release = await broker.getField("L1", "password", "https://pizza.example/login");
    expect(release.hidden).toBe(true);
    expect(release.value.length).toBeGreaterThan(0);
    const visible = await broker.getField("L1", "username", "https://pizza.example/login");
    expect(visible.hidden).toBe(false);
  });

  it("refuses a release that does not say whether the field is concealed", async () => {
    // Never guess the flag: without it there is no way to know whether the
    // value may be shown, so it is not handed over at all.
    const stray = path.join(dir, "noflag.cjs");
    fs.writeFileSync(stray, 'process.stdout.write(JSON.stringify({value:"secret"}))\n');
    const odd = new CredentialBroker({ command: [process.execPath, stray] });
    await expect(odd.getField("S1", "password", "https://x.example/")).rejects.toThrow(
      /did not say whether/,
    );
  });
});
