import fs from "node:fs";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Exercise the shipping close gate without booting Electron or the device.
const source = ts.createSourceFile("main.ts", fs.readFileSync(
  new URL("../src/main.ts", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true);
const gate = source.statements.find((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === "mayLeaveMain",
)!;
const compiled = ts.transpileModule(gate.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup() {
  const ipcMain = new EventEmitter();
  const mayLeave = vm.runInNewContext(`${compiled}; mayLeaveMain`, {
    ipcMain, agentToken: "pending-setup-token", leaveInFlight: null, settleLeave: null,
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
