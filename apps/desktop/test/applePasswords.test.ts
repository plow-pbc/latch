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
import { ApplePasswords, ApwWarmup, checkApwPrereqs } from "../src/applePasswords.js";
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
let warmup: ApwWarmup | null;
let audits: { event: string; fields: Record<string, unknown> }[];

function makeManager(overrides: { warmupProbeHosts?: string[] } = {}): ApplePasswords {
  return new ApplePasswords({
    apwCommand: ["node", FAKE_APW],
    credentials,
    isEnabled: () => enabled,
    setEnabled: (on) => {
      enabled = on;
    },
    // Empty by default so tests exercise probing only when they mean to.
    warmupProbeHosts: overrides.warmupProbeHosts ?? [],
    // Hermetic: never read this machine's real /Applications or profiles.
    prereqs: () => ({ browser: "Google Chrome", browserApp: "Google Chrome", extensionInstalled: true }),
    loadWarmup: () => warmup,
    saveWarmup: (w) => {
      warmup = w;
    },
    audit: (event, fields) => audits.push({ event, fields: fields as Record<string, unknown> }),
    onChange: () => changes++,
    startTimeoutMs: 10_000,
    startSettleMs: 0,
    pinRetryDelayMs: 10,
    pairProbeAttempts: 2,
    pairProbeIntervalMs: 50,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-ap-"));
  fs.writeFileSync(
    path.join(dir, "vault.json"),
    JSON.stringify([
      { username: "jon", domain: "pizza.example", sites: [], password: "hunter2" },
    ]),
  );
  enabled = false;
  changes = 0;
  warmup = null;
  audits = [];
  credentials = new CredentialSourceSwitch(dummySource, "1password");
  ap = makeManager();
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

describe("checkApwPrereqs", () => {
  function roots() {
    const applicationsDir = path.join(dir, "Applications");
    const appSupportDir = path.join(dir, "AppSupport");
    const apwDataDir = path.join(dir, "apw-data");
    fs.mkdirSync(applicationsDir, { recursive: true });
    fs.mkdirSync(appSupportDir, { recursive: true });
    return { applicationsDir, appSupportDir, apwDataDir };
  }

  it("reports no browser and no extension on a bare Mac", () => {
    expect(checkApwPrereqs(roots())).toEqual({ browser: null, browserApp: null, extensionInstalled: false });
  });

  it("finds a supported browser without the extension", () => {
    const r = roots();
    fs.mkdirSync(path.join(r.applicationsDir, "Google Chrome.app"), { recursive: true });
    expect(checkApwPrereqs(r)).toEqual({ browser: "Google Chrome", browserApp: "Google Chrome", extensionInstalled: false });
  });

  it("finds the extension in a browser profile", () => {
    const r = roots();
    fs.mkdirSync(path.join(r.applicationsDir, "Google Chrome.app"), { recursive: true });
    fs.mkdirSync(
      path.join(r.appSupportDir, "Google/Chrome/Default/Extensions/pejdijmoenmkgeppbflobdenhhabjlaj"),
      { recursive: true },
    );
    expect(checkApwPrereqs(r).extensionInstalled).toBe(true);
  });

  it("apw's own cached extension copy satisfies the prerequisite", () => {
    const r = roots();
    // Removed from the browser, but apw already copied it (the live setup).
    fs.mkdirSync(path.join(r.apwDataDir, "extension"), { recursive: true });
    fs.writeFileSync(path.join(r.apwDataDir, "extension", "background.js.orig"), "");
    expect(checkApwPrereqs(r).extensionInstalled).toBe(true);
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

  it("a fill remembers its host; the next pairing warms up the AutoFill consent", async () => {
    await ap.enable();
    await ap.submitPin("123456");
    // A real fill happens (value dropped immediately, as in fillSecret).
    await credentials.getField("jon", "password", "https://pizza.example/login");
    expect(warmup).toEqual({ host: "pizza.example", username: "jon" });

    // "Next launch": a fresh manager over the same persisted state.
    await ap.shutdown();
    ap = makeManager();
    audits = [];
    await ap.enable(false);
    await ap.submitPin("123456");
    await new Promise((r) => setTimeout(r, 200)); // warm-up is fire-and-forget
    const warmed = audits.find((a) => a.event === "apw_warmup");
    expect(warmed?.fields).toMatchObject({ host: "pizza.example", ok: true });
    expect(JSON.stringify(audits)).not.toContain("hunter2");
    expect(ap.view().detail).toContain("approved for this session");
  });

  it("with nothing remembered, probing common domains finds an entry to warm with", async () => {
    ap = makeManager({ warmupProbeHosts: ["nowhere.example", "pizza.example"] });
    await ap.enable();
    await ap.submitPin("123456");
    await new Promise((r) => setTimeout(r, 400));
    const warmed = audits.find((a) => a.event === "apw_warmup");
    expect(warmed?.fields).toMatchObject({ host: "pizza.example", ok: true, source: "probe" });
    // The probe hit is remembered, so future launches skip the probing.
    expect(warmup).toEqual({ host: "pizza.example", username: "jon" });
    expect(ap.view().detail).toContain("approved for this session");
  });

  it("with nothing remembered and no probe hit, the skip is visible in audit and status", async () => {
    await ap.enable();
    await ap.submitPin("123456");
    await new Promise((r) => setTimeout(r, 200));
    expect(audits.find((a) => a.event === "apw_warmup")?.fields).toMatchObject({ skipped: true });
    expect(ap.view().detail).toContain("first password use");
  });

  it("a stale warm-up memory (entry deleted) is forgotten, not fatal", async () => {
    warmup = { host: "gone.example", username: "nobody" };
    await ap.enable();
    expect(await ap.submitPin("123456")).toBe(true); // pairing unaffected
    await new Promise((r) => setTimeout(r, 200));
    expect(audits.find((a) => a.event === "apw_warmup")?.fields.ok).toBe(false);
    expect(warmup).toBeNull();
  });

  it("dismissing the PIN leaves it unpaired; requesting a new PIN un-dismisses", async () => {
    await ap.enable();
    expect(ap.view()).toMatchObject({ state: "awaiting-pin", dismissed: false });
    ap.dismissPin();
    // Still unpaired — nothing about the daemon changed, only the UI intent.
    expect(ap.view()).toMatchObject({ state: "awaiting-pin", dismissed: true });
    await ap.requestPin(); // the banner's own "New PIN"
    expect(ap.view()).toMatchObject({ state: "awaiting-pin", dismissed: false });
    expect(await ap.submitPin("123456")).toBe(true);
  });

  it("Pair after a dismissal restarts pairing with a fresh helper session", async () => {
    await ap.enable();
    const firstPid = fs.readFileSync(path.join(dir, "state", "daemon"), "utf8");
    ap.dismissPin();
    await ap.restartPairing(); // Settings' "Pair" button
    expect(ap.view()).toMatchObject({ state: "awaiting-pin", dismissed: false });
    // A genuinely new daemon (→ new extension session → new challenge/PIN):
    const secondPid = fs.readFileSync(path.join(dir, "state", "daemon"), "utf8");
    expect(secondPid).not.toBe(firstPid);
    expect(await ap.submitPin("123456")).toBe(true);
  });

  it("shutdown kills the daemon but keeps the setting for next launch", async () => {
    await ap.enable();
    await ap.submitPin("123456");
    await ap.shutdown();
    expect(enabled).toBe(true); // still on — next launch pairs again
    expect(fs.existsSync(path.join(dir, "state", "daemon"))).toBe(false);
  });
});
