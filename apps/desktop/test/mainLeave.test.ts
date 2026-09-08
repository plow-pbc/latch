import fs from "node:fs";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Exercise the shipping close gate without booting Electron or the device.
const source = ts.createSourceFile("main.ts", fs.readFileSync(
  new URL("../src/main.ts", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true);
const gates = source.statements.filter((node) =>
  ts.isFunctionDeclaration(node) && ["mayLeaveMain", "hasPendingAgentSetup"].includes(node.name?.text ?? ""),
);
const compiled = ts.transpileModule(gates.map((gate) => gate.getText(source)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup(agentToken: string | null = "pending-setup-token", busy = false, credential: unknown = null, phase = "idle") {
  const ipcMain = new EventEmitter();
  const mayLeave = vm.runInNewContext(`${compiled}; mayLeaveMain`, {
    ipcMain, agentToken, leaveInFlight: null, settleLeave: null,
    connectClient: { state: () => ({ busy, credential }) },
    cloudAgents: { state: () => ({ cloudLineFlow: { phase } }) },
  }) as (win: unknown) => Promise<boolean>;
  return { ipcMain, mayLeave };
}

describe("main window leave decision", () => {
  it.each([null, { isDestroyed: () => true }])("allows quit without a usable window: %s", async (win) => {
    expect(await setup().mayLeave(win)).toBe(true);
  });

  it.each([true, false])("honours the renderer answer %s with a pending token", async (answer) => {
    const { ipcMain, mayLeave } = setup();
    const send = vi.fn(() => ipcMain.emit("ui:confirmLeaveReply", {}, answer));
    const result = await mayLeave({
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: { isLoading: () => false, send },
    });
    expect(result).toBe(answer);
    expect(send).toHaveBeenCalledWith("ui:confirmLeave", true);
    expect(ipcMain.listenerCount("ui:confirmLeaveReply")).toBe(0);
  });
});

it.each([
  [true, null, "idle", true],
  [false, { token: "static-token" }, "idle", true],
  [false, null, "creating", true],
  [false, null, "idle", false],
] as const)("passes pending setup state to the renderer: %s %s %s", async (busy, credential, phase, pending) => {
  const { ipcMain, mayLeave } = setup(null, busy, credential, phase);
  const send = vi.fn(() => ipcMain.emit("ui:confirmLeaveReply", {}, !pending));
  expect(await mayLeave({
    isDestroyed: () => false, isVisible: () => true,
    webContents: { isLoading: () => false, send },
  })).toBe(!pending);
  expect(send).toHaveBeenCalledWith("ui:confirmLeave", pending);
});
