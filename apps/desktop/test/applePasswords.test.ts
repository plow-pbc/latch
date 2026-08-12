/**
 * The Apple Passwords orchestrator: setting off by default; enabling flips the
 * credential switch immediately (no silent 1Password fallback), starts + pairs
 * the daemon, and disabling / quitting kills the daemon (which is unpairing).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialSource, CredentialSourceSwitch } from "@domo/device-core";
import { ApplePasswords } from "../src/applePasswords.js";
import { loadSettings } from "../src/settings.js";

const FAKE_APW = fileURLToPath(new URL("../../../e2e/fixtures/fakeApw.cjs", import.meta.url));

const dummySource: CredentialSource = {
  whatsHere: async () => [],
  describeItem: async (id) => ({ id, title: id, category: "login", fields: [] }),
  getField: async () => "",
};

let dir: string;
let enabled: boolean;
let ap: ApplePasswords;
let credentials: CredentialSourceSwitch;
let changes: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-ap-"));
  fs.writeFileSync(path.join(dir, "vault.json"), "[]");
  enabled = false;
  changes = 0;
  credentials = new CredentialSourceSwitch(dummySource, "1password");
  ap = new ApplePasswords({
    apwCommand: ["node", FAKE_APW],
    credentials,
    isEnabled: () => enabled,
    setEnabled: (on) => {
      enabled = on;
    },
    onChange: () => changes++,
    startTimeoutMs: 10_000,
    startSettleMs: 0,
    pinRetryDelayMs: 10,
    pairProbeAttempts: 2,
    pairProbeIntervalMs: 50,
  });
  process.env.FAKE_APW_STATE = path.join(dir, "state");
  process.env.FAKE_APW_VAULT = path.join(dir, "vault.json");
});
afterEach(async () => {
  await ap.shutdown();
  delete process.env.FAKE_APW_STATE;
  delete process.env.FAKE_APW_VAULT;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("settings default", () => {
  it("Apple Passwords is off by default", () => {
    expect(loadSettings(dir).applePasswordsEnabled).toBe(false);
  });
});

describe("ApplePasswords", () => {
  it("startIfEnabled is a no-op while the setting is off", async () => {
    await ap.startIfEnabled();
    expect(ap.view().state).toBe("stopped");
    expect(credentials.active).toBe("1password");
  });

  it("enable persists, switches the source, and reaches awaiting-pin", async () => {
    await ap.enable();
    expect(enabled).toBe(true);
    expect(credentials.active).toBe("apple-passwords");
    expect(ap.view()).toMatchObject({ enabled: true, available: true, state: "awaiting-pin" });
    expect(changes).toBeGreaterThan(0);
  });

  it("submitPin completes pairing; disable unpairs and restores 1Password", async () => {
    await ap.enable();
    expect(await ap.submitPin("999999")).toBe(false);
    expect(ap.view().state).toBe("awaiting-pin");
    expect(await ap.submitPin("123456")).toBe(true);
    expect(ap.view().state).toBe("paired");
    // Even unpaired-yet-enabled never fell back to 1Password silently:
    expect(credentials.active).toBe("apple-passwords");

    await ap.disable();
    expect(enabled).toBe(false);
    expect(credentials.active).toBe("1password");
    expect(ap.view().state).toBe("stopped");
  });

  it("a PIN that was delivered but not verified is NOT reported as paired", async () => {
    // apw acks `auth response` before the SRP verification settles, so a
    // mistyped PIN exits 0; only the probe knows the session never came up.
    await ap.enable();
    expect(await ap.submitPin("999999")).toBe(false);
    expect(ap.view().state).toBe("awaiting-pin");
  });

  it("a dropped helper session re-enters the PIN flow on the next fill", async () => {
    await ap.enable();
    await ap.submitPin("123456");
    expect(ap.view().state).toBe("paired");
    fs.rmSync(path.join(dir, "state", "paired")); // helper session drops
    await expect(credentials.whatsHere("https://pizza.example/")).rejects.toMatchObject({
      type: "ApwNotPaired",
    });
    // The broker's onNotPaired hook kicks the daemon back into the PIN flow.
    await new Promise((r) => setTimeout(r, 300));
    expect(ap.view().state).toBe("awaiting-pin");
    expect(await ap.submitPin("123456")).toBe(true);
    expect(ap.view().state).toBe("paired");
  });

  it("a start failure surfaces as the error state with detail", async () => {
    process.env.FAKE_APW_FAIL = "no-browser";
    try {
      await ap.enable();
    } finally {
      delete process.env.FAKE_APW_FAIL;
    }
    expect(ap.view().state).toBe("error");
    expect(ap.view().detail).toContain("No supported browser");
    // The setting stays on — the user's intent is preserved for a retry.
    expect(enabled).toBe(true);
  });

  it("reports unavailable with no bundled binary and refuses to enable", async () => {
    const none = new ApplePasswords({
      apwCommand: null,
      credentials,
      isEnabled: () => enabled,
      setEnabled: (on) => {
        enabled = on;
      },
    });
    expect(none.view().available).toBe(false);
    await none.enable();
    expect(credentials.active).toBe("1password");
    expect(none.view().state).toBe("stopped");
  });

  it("shutdown kills the daemon but keeps the setting for next launch", async () => {
    await ap.enable();
    await ap.submitPin("123456");
    await ap.shutdown();
    expect(enabled).toBe(true); // still on — next launch pairs again
    expect(fs.existsSync(path.join(dir, "state", "daemon"))).toBe(false);
  });
});
