import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const source = ts.createSourceFile("main.ts", fs.readFileSync(
  new URL("../src/main.ts", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true);

const registration = (channel: string) => source.statements.find((node) =>
  ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === "ipcMain.handle"
  && ts.isStringLiteral(node.expression.arguments[0])
  && node.expression.arguments[0].text === channel,
)!;
const requested = source.statements.find((node) =>
  ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
    ts.isIdentifier(declaration.name) && declaration.name.text === "vaultImportRequested"),
)!;
const compiled = ts.transpileModule([
  requested,
  registration("onboarding:finish"),
  registration("vault:importRequested"),
  registration("vault:importAcknowledged"),
].map((node) => node.getText(source)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

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
