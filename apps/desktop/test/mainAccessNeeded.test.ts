import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CONNECTOR_SETUP_WAIT_MS, Connectors } from "../src/connectors.js";
import { Onboarding } from "../src/onboarding.js";
import { PlowApi } from "../src/plowApi.js";
import { loadSettings, saveSettings } from "../src/settings.js";

// Plugins → Continue through the shipping access decision, without Electron.
const source = ts.createSourceFile("main.ts", fs.readFileSync(
  new URL("../src/main.ts", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true);
const decision = source.statements.find((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === "accessNeeded",
)!;
const compiled = ts.transpileModule(decision.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

let home: string;
beforeEach(() => {
  vi.useFakeTimers();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-access-needed-"));
  // A Mac holding an incomplete setup reopens on Plugins.
  saveSettings(home, { ...loadSettings(home), relayCredential: "plow_resumed_setup_credential" });
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(home, { recursive: true, force: true });
});

it.each([
  { name: "a resumed setup reads a connected Google from Plow", primed: false, plowHangs: false, lands: "availability" },
  { name: "a hanging Plow answers from the polled accounts", primed: true, plowHangs: true, lands: "availability" },
  { name: "a hanging Plow with nothing polled yet routes to Access", primed: false, plowHangs: true, lands: "access" },
])("Plugins → Continue lands within the wait: $name", async ({ primed, plowHangs, lands }) => {
  let hang = false;
  const connectors = new Connectors({
    api: {
      listConnectors: () => hang
        ? new Promise(() => {})
        : Promise.resolve({ google: { accounts: [{ email: "owner@example.com", isDefault: true }] } }),
    } as unknown as PlowApi,
    credential: () => loadSettings(home).relayCredential,
    openExternal: async () => {},
    recordAudit: () => {},
  });
  if (primed) await connectors.poll();
  hang = plowHangs;
  const accessNeeded = vm.runInNewContext(`${compiled}; accessNeeded`, {
    connectors,
    setTimeout,
    CONNECTOR_SETUP_WAIT_MS,
    // Gmail's grant is met exactly when an account is connected.
    pluginsNow: async () => ({
      grants: [{ status: connectors.state().google.accounts.length ? "met" : "open" }],
    }),
  }) as () => Promise<boolean>;
  const onboarding = new Onboarding({
    api: new PlowApi("https://api.plow.co"),
    home,
    startRelay: async () => {},
    deviceName: "Plow Latch (test)",
    applyPluginDefault: async () => {},
    accessNeeded,
  });
  expect(onboarding.state().step).toBe("plugins");

  let landed: string | null = null;
  void onboarding.advance().then((state) => { landed = state.step; });
  await vi.advanceTimersByTimeAsync(CONNECTOR_SETUP_WAIT_MS);

  expect(landed).toBe(lands);
});
