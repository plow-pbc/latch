/**
 * BrowserSessions with the Apple Passwords credential source: the same
 * fill_secret gate chain as 1Password, with apw's username-as-item-id model —
 * and no secret value ever in results or the audit stream.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSONValue, jv } from "@domo/protocol";
import {
  ApwCredentialBroker,
  BrowserHost,
  BrowserSessions,
  CredentialBroker,
  CredentialSourceSwitch,
} from "@domo/device-core";

const FAKE_SERVER = fileURLToPath(
  new URL("../../../e2e/fixtures/fakeBrowserServer.cjs", import.meta.url),
);
const FAKE_APW = fileURLToPath(new URL("../../../e2e/fixtures/fakeApw.cjs", import.meta.url));
const FAKE_OP = fileURLToPath(new URL("../../../e2e/fixtures/fakeOpBroker.cjs", import.meta.url));

const AGENT = "agent-1";

let dir: string;
let fillLog: string;
let events: { event: string; fields: { [k: string]: JSONValue } }[];
let host: BrowserHost;
let sessions: BrowserSessions;
let credentials: CredentialSourceSwitch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-bsapw-"));
  fillLog = path.join(dir, "fills.log");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir);
  // Paired daemon state, so broker calls resolve.
  fs.writeFileSync(path.join(stateDir, "daemon"), "0");
  fs.writeFileSync(path.join(stateDir, "paired"), "");
  const vaultPath = path.join(dir, "vault.json");
  fs.writeFileSync(
    vaultPath,
    JSON.stringify([
      {
        username: "jon",
        domain: "pizza.example",
        sites: ["https://pizza.example/login"],
        password: "hunter2",
        otp: "246810",
      },
      { username: "x", domain: "elsewhere.example", sites: [], password: "sekret" },
    ]),
  );
  events = [];
  const audit = (event: string, fields: { [k: string]: JSONValue }) =>
    events.push({ event, fields });
  host = new BrowserHost({
    command: ["node", FAKE_SERVER],
    env: { FAKE_FILL_LOG: fillLog },
    screenshotsDir: path.join(dir, "shots"),
    audit,
  });
  const apw = new ApwCredentialBroker({
    command: ["node", FAKE_APW],
    env: { FAKE_APW_STATE: stateDir, FAKE_APW_VAULT: vaultPath },
  });
  // Model the production shape: the switch starts on 1Password and the app
  // flips it to Apple Passwords.
  credentials = new CredentialSourceSwitch(
    new CredentialBroker({ command: ["node", FAKE_OP], env: { FAKE_OP_VAULT: vaultPath } }),
    "1password",
    (source) => audit("credential_source_changed", { source }),
  );
  credentials.set(apw, "apple-passwords");
  sessions = new BrowserSessions(host, credentials, audit, 60_000);
});
afterEach(async () => {
  await sessions.closeAll("test");
  fs.rmSync(dir, { recursive: true, force: true });
});

async function openSession(): Promise<string> {
  const r = jv(await sessions.open("int-1", AGENT, ["pizza.example"], true));
  expect(r.get("status").str).toBe("completed");
  return r.get("session").str!;
}

describe("browser sessions over Apple Passwords", () => {
  it("audits the credential source switch", () => {
    const switched = events.find((e) => e.event === "credential_source_changed");
    expect(switched?.fields.source).toBe("apple-passwords");
  });

  it("lists metadata with usernames as item ids — no secrets", async () => {
    const s = await openSession();
    await sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/login" });
    const r = jv(await sessions.command(AGENT, s, { action: "credentials" }));
    expect(r.get("status").str).toBe("completed");
    const items = r.get("items").arr!;
    expect(items.length).toBe(1); // only the entry matching this page
    expect(jv(items[0]).get("id").str).toBe("jon");
    expect(JSON.stringify(items)).not.toContain("hunter2");
  });

  it("fills a password on-device and never returns or audits it", async () => {
    const s = await openSession();
    sessions.extend("int-2", AGENT, s, [], ["jon"], false);
    await sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/login" });
    const r = jv(
      await sessions.command(AGENT, s, {
        action: "fill_secret",
        selector: "#pass",
        item: "jon",
        field: "password",
      }),
    );
    expect(r.get("status").str).toBe("completed");
    expect(fs.readFileSync(fillLog, "utf8")).toContain("#pass\thunter2");
    expect(JSON.stringify(r.value)).not.toContain("hunter2");
    expect(JSON.stringify(events)).not.toContain("hunter2");
    const filled = events.find((e) => e.event === "credential_filled")!;
    expect(filled.fields.item).toBe("jon");
    expect(filled.fields.origin).toBe("pizza.example");
  });

  it("fills a one-time code via the otp field", async () => {
    const s = await openSession();
    sessions.extend("int-2", AGENT, s, [], ["jon"], false);
    await sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/login" });
    const r = jv(
      await sessions.command(AGENT, s, {
        action: "fill_secret",
        selector: "#pass",
        item: "jon",
        field: "otp",
      }),
    );
    expect(r.get("status").str).toBe("completed");
    expect(fs.readFileSync(fillLog, "utf8")).toContain("#pass\t246810");
  });

  it("refuses an approved item that belongs to another site", async () => {
    const s = await openSession();
    sessions.extend("int-2", AGENT, s, [], ["x"], false);
    await sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/login" });
    const r = jv(
      await sessions.command(AGENT, s, {
        action: "fill_secret",
        selector: "#pass",
        item: "x",
        field: "password",
      }),
    );
    expect(r.get("status").str).toBe("error");
    expect(r.get("error").str).toContain("refused");
    expect(JSON.stringify(events)).not.toContain("sekret");
    const denied = events.filter((e) => e.event === "credential_denied");
    expect(JSON.stringify(denied)).toContain("ApwDenied");
  });

  it("reset() returns the switch to 1Password and audits it", () => {
    credentials.reset();
    expect(credentials.active).toBe("1password");
    const sources = events
      .filter((e) => e.event === "credential_source_changed")
      .map((e) => e.fields.source);
    expect(sources).toEqual(["apple-passwords", "1password"]);
  });
});
