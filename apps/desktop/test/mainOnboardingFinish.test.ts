import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileMain, mainHandler, mainSource } from "./mainSource.js";

const requested = mainSource.statements.find((node) =>
  ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
    ts.isIdentifier(declaration.name) && declaration.name.text === "vaultImportRequested"),
)!;
const compiled = compileMain(
  requested,
  mainHandler("onboarding:finish"),
  mainHandler("vault:importRequested"),
  mainHandler("vault:importAcknowledged"),
);

describe("onboarding password import handoff", () => {
  it.each([
    ["import", false],
    ["enable-browser-and-import", true],
  ] as const)("routes %s to Vault and explicitly enables Browser only when named", async (destination, enablesBrowser) => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const disabled = new Set(["browser"]);
    const settings = { selectedTab: "audit" };
    let synced = 0;
    vm.runInNewContext(compiled, {
      BROWSER_PLUGIN: "browser",
      home: "/home",
      ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
      updateDisabledPlugins: async (change: (plugins: Set<string>) => void) => change(disabled),
      loadSettings: () => ({ ...settings }),
      saveSettings: (_home: string, next: typeof settings) => Object.assign(settings, next),
      gate: { sync: () => { synced += 1; } },
    });

    await handlers.get("onboarding:finish")!({}, destination);
    expect(settings.selectedTab).toBe("vault");
    expect(await handlers.get("vault:importRequested")!()).toBe(true);
    expect(disabled.has("browser")).toBe(!enablesBrowser);
    expect(synced).toBe(1);
    await handlers.get("vault:importAcknowledged")!();
    expect(await handlers.get("vault:importRequested")!()).toBe(false);
  });
});
