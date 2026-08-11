/**
 * Apple Passwords credential source: the ApwCredentialBroker mapping onto the
 * apw CLI, and the ApwDaemon pairing state machine — all against the fake apw
 * fixture (no deno, no Chromium, no iCloud).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSONValue } from "@domo/protocol";
import { ApwCredentialBroker, ApwDaemon, CredentialError } from "@domo/device-core";

const FAKE_APW = fileURLToPath(new URL("../../../e2e/fixtures/fakeApw.cjs", import.meta.url));

let dir: string;
let stateDir: string;
let vaultPath: string;
let env: Record<string, string>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-apw-"));
  stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  vaultPath = path.join(dir, "vault.json");
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
      { username: "alt", domain: "pizza.example", sites: [], password: "second" },
      { username: "x", domain: "elsewhere.example", sites: [], password: "sekret" },
    ]),
  );
  env = { FAKE_APW_STATE: stateDir, FAKE_APW_VAULT: vaultPath };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function pair(): void {
  fs.writeFileSync(path.join(stateDir, "daemon"), "0");
  fs.writeFileSync(path.join(stateDir, "paired"), "");
}

function broker(): ApwCredentialBroker {
  return new ApwCredentialBroker({ command: ["node", FAKE_APW], env });
}

describe("ApwCredentialBroker", () => {
  it("lists matching entries as metadata — username is the id, no secrets", async () => {
    pair();
    const items = await broker().whatsHere("https://pizza.example/login");
    expect(items.map((i) => i.id).sort()).toEqual(["alt", "jon"]);
    const jon = items.find((i) => i.id === "jon")!;
    expect(jon.username).toBe("jon");
    expect(jon.category).toBe("login");
    expect(jon.matchesThisPage).toBe(true);
    expect(JSON.stringify(items)).not.toContain("hunter2");
  });

  it("describeItem exposes the fixed apw field labels and a cached title", async () => {
    pair();
    const b = broker();
    await b.whatsHere("https://pizza.example/login");
    const item = await b.describeItem("jon");
    expect(item.fields).toEqual(["username", "password", "otp"]);
    expect(item.title).toContain("jon");
    // Never-listed ids fall back to the raw id (the approval card shows it).
    expect((await b.describeItem("ghost")).title).toBe("ghost");
  });

  it("releases a password bound to the queried page URL", async () => {
    pair();
    await expect(broker().getField("jon", "password", "https://pizza.example/login")).resolves.toBe(
      "hunter2",
    );
  });

  it("releases the current one-time code via the otp field", async () => {
    pair();
    await expect(broker().getField("jon", "otp", "https://pizza.example/login")).resolves.toBe(
      "246810",
    );
  });

  it("refuses an item that belongs to another site (Apple's domain matching)", async () => {
    pair();
    await expect(
      broker().getField("x", "password", "https://pizza.example/login"),
    ).rejects.toMatchObject({ type: "ApwDenied" });
  });

  it("refuses unknown fields with a typed error", async () => {
    pair();
    await expect(
      broker().getField("jon", "credit-card", "https://pizza.example/"),
    ).rejects.toMatchObject({ type: "ApwNoSuchField" });
  });

  it("maps the unpaired daemon to ApwNotPaired", async () => {
    // No pair(): the fake reports INVALID_SESSION like a stopped/unpaired apw.
    const err = await broker()
      .whatsHere("https://pizza.example/")
      .then(
        () => null,
        (e: unknown) => e as CredentialError,
      );
    expect(err?.type).toBe("ApwNotPaired");
    expect(err?.message).toContain("Domo Settings");
  });

  it("reports a dropped helper session via onNotPaired", async () => {
    pair();
    let notPaired = 0;
    const b = new ApwCredentialBroker({
      command: ["node", FAKE_APW],
      env,
      onNotPaired: () => notPaired++,
    });
    await b.whatsHere("https://pizza.example/"); // healthy: no callback
    expect(notPaired).toBe(0);
    fs.rmSync(path.join(stateDir, "paired")); // the helper session drops
    await expect(b.whatsHere("https://pizza.example/")).rejects.toMatchObject({
      type: "ApwNotPaired",
    });
    expect(notPaired).toBe(1);
  });
});

describe("ApwDaemon", () => {
  const events: { event: string; fields: { [k: string]: JSONValue } }[] = [];
  let daemon: ApwDaemon | null;

  beforeEach(() => {
    events.length = 0;
    daemon = null;
  });
  afterEach(async () => {
    await daemon?.stop();
  });

  function makeDaemon(extraEnv: Record<string, string> = {}): ApwDaemon {
    daemon = new ApwDaemon({
      command: ["node", FAKE_APW],
      env: { ...env, ...extraEnv },
      startTimeoutMs: 10_000,
      pairProbeAttempts: 2,
      pairProbeIntervalMs: 50,
      audit: (event, fields) => events.push({ event, fields }),
    });
    return daemon;
  }

  it("start → requestPin → wrong PIN stays awaiting → right PIN pairs", async () => {
    const d = makeDaemon();
    await d.start();
    await d.requestPin();
    expect(d.status().state).toBe("awaiting-pin");
    // macOS's dialog was actually requested from the helper:
    expect(fs.existsSync(path.join(stateDir, "pin-requested"))).toBe(true);

    expect(await d.submitPin("000000")).toBe(false);
    expect(d.status().state).toBe("awaiting-pin");
    expect(await d.submitPin("12ab")).toBe(false); // malformed, never sent

    expect(await d.submitPin("123456")).toBe(true);
    expect(d.status().state).toBe("paired");

    // The pairing is real: queries now succeed against the same state.
    const b = new ApwCredentialBroker({ command: ["node", FAKE_APW], env });
    await expect(b.getField("jon", "password", "https://pizza.example/")).resolves.toBe("hunter2");
  });

  it("repair() re-enters the PIN flow from paired (and only from paired)", async () => {
    const d = makeDaemon();
    await d.start();
    await d.repair(); // not paired yet — no-op
    expect(d.status().state).toBe("starting");
    await d.requestPin();
    await d.submitPin("123456");
    fs.rmSync(path.join(stateDir, "paired")); // the helper session drops
    await d.repair();
    expect(d.status().state).toBe("awaiting-pin");
    expect(await d.submitPin("123456")).toBe(true); // re-pairing works
  });

  it("stop kills the daemon and the pairing with it", async () => {
    const d = makeDaemon();
    await d.start();
    await d.requestPin();
    await d.submitPin("123456");
    await d.stop();
    expect(d.status().state).toBe("stopped");
    const b = new ApwCredentialBroker({ command: ["node", FAKE_APW], env });
    await expect(b.whatsHere("https://pizza.example/")).rejects.toMatchObject({
      type: "ApwNotPaired",
    });
  });

  it("surfaces a start failure (no supported browser) as the error state", async () => {
    const d = makeDaemon({ FAKE_APW_FAIL: "no-browser" });
    await expect(d.start()).rejects.toMatchObject({ type: "ApwStartFailed" });
    expect(d.status().state).toBe("error");
    expect(d.status().detail).toContain("No supported browser");
  });

  it("a daemon that dies after starting lands in the error state", async () => {
    const d = makeDaemon({ FAKE_APW_EXIT_AFTER: "300" });
    await d.start();
    await new Promise((r) => setTimeout(r, 900));
    expect(d.status().state).toBe("error");
    expect(d.status().detail).toContain("stopped");
  });

  it("audits state transitions but never a PIN", async () => {
    const d = makeDaemon();
    await d.start();
    await d.requestPin();
    await d.submitPin("123456");
    const states = events.filter((e) => e.event === "apw_state").map((e) => e.fields.state);
    expect(states).toEqual(["starting", "awaiting-pin", "paired"]);
    expect(JSON.stringify(events)).not.toContain("123456");
  });
});
