import { EventEmitter } from "node:events";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { compileMain, mainFunctions } from "./mainSource.js";

// Exercise the shipping close gate without booting Electron or the device.
const compiled = compileMain(...mainFunctions("mayLeaveMain", "hasPendingAgentSetup"));
const compiledRelay = compileMain(...mainFunctions("signOutThisMac", "startRelay"));

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

it("keeps a reactivated relay when the signed-out relay is still stopping", async () => {
  let releaseStop!: () => void;
  const stopping = new Promise<void>((resolve) => { releaseStop = resolve; });
  const oldRelay = { stop: vi.fn(() => stopping) };
  const settings = { relayCredential: "", accountUid: "", mcpUrl: "" };
  const clients: object[] = [];
  class RelayClient {
    constructor(_options: unknown) { clients.push(this); }
    async start() {}
  }
  const runtime = vm.runInNewContext(
    `${compiledRelay}; ({ signOutThisMac, startRelay, relay: () => relay })`,
    {
      relay: oldRelay, connected: true, home: "home", mainWindow: null,
      hasPendingAgentSetup: () => false, isSignedIn: () => false,
      telemetry: null, queueRevokeAndSignOut: vi.fn(), pendingRevokeRetrier: null,
      resetSignedOutRuntime: vi.fn(), notifyRenderer: vi.fn(),
      loadSettings: () => ({ ...settings }), saveSettings: vi.fn(),
      device: { identity: { deviceId: "device-1" } }, mcp: {},
      RelayClient, relaySocketUrl: () => "wss://relay", apiBaseUrl: "https://api.plow.co",
      loggingFetch: vi.fn(), PlowApi: class {}, hostName: () => "test-mac",
      connectors: null, signInAgainIfOldKey: vi.fn(), signOut: vi.fn(), console,
    },
  ) as { signOutThisMac(): Promise<void>; startRelay(): Promise<void>; relay(): object | null };

  const signingOut = runtime.signOutThisMac();
  await Promise.resolve();
  settings.relayCredential = "plow_reactivated";
  await runtime.startRelay();
  const reactivated = runtime.relay();

  releaseStop();
  await signingOut;

  expect(clients).toHaveLength(1);
  expect(runtime.relay()).toBe(reactivated);
});
