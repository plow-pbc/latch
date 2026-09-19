import { EventEmitter } from "node:events";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { compileMain, mainFunctions } from "./mainSource.js";

// Exercise the shipping close gate without booting Electron or the device.
const compiled = compileMain(...mainFunctions("mayLeaveMain", "hasPendingAgentSetup"));

function setup(busy = false, credential: unknown = null) {
  const ipcMain = new EventEmitter();
  const mayLeave = vm.runInNewContext(`${compiled}; mayLeaveMain`, {
    ipcMain, leaveInFlight: null, settleLeave: null,
    connectClient: { state: () => ({ busy, credential }) },
  }) as (win: unknown) => Promise<boolean>;
  return { ipcMain, mayLeave };
}

describe("main window leave decision", () => {
  it.each([null, { isDestroyed: () => true }])("allows quit without a usable window: %s", async (win) => {
    expect(await setup().mayLeave(win)).toBe(true);
  });

  it.each([true, false])("honours the renderer answer %s with a pending token", async (answer) => {
    const { ipcMain, mayLeave } = setup(false, { token: "static-token" });
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
  [true, null, true],
  [false, { token: "static-token" }, true],
  [false, null, false],
] as const)("passes pending setup state to the renderer: %s %s %s", async (busy, credential, pending) => {
  const { ipcMain, mayLeave } = setup(busy, credential);
  const send = vi.fn(() => ipcMain.emit("ui:confirmLeaveReply", {}, !pending));
  expect(await mayLeave({
    isDestroyed: () => false, isVisible: () => true,
    webContents: { isLoading: () => false, send },
  })).toBe(!pending);
  expect(send).toHaveBeenCalledWith("ui:confirmLeave", pending);
});
