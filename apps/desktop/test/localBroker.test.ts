/**
 * Local mode: the app-internal broker over Unix sockets. Covers the full loop
 * headlessly — device connects and registers, spawn_agent advertises the local
 * agent socket + shim, an agent authenticates on that socket — plus lifecycle
 * (stop() unlinks the sockets) and the short-path fallback for deep homes.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalBytes, Intent, jv, parseJSON } from "@domo/protocol";
import { DeviceAgent, PolicyDelegate } from "@domo/device-core";
import { localSocketPaths, startLocalBroker, LocalBrokerHandle } from "../src/localBroker.js";

/** Auto-approving policy — decisions are not under test here. */
const approveAll: PolicyDelegate = {
  decideAccess: async () => true,
  decideIntent: async (_intent: Intent) => ({ decision: "allow_once" as const, source: "test" }),
};

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "domo-lb-"));
}

/** Dial a socket, send one line, resolve with the first line received. */
function requestLine(socket: string, line: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket);
    let buffer = "";
    conn.on("connect", () => conn.write(Buffer.concat([line, Buffer.from("\n")])));
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        conn.destroy();
        resolve(buffer.slice(0, idx));
      }
    });
    conn.on("error", reject);
  });
}

describe("local mode broker", () => {
  let handle: LocalBrokerHandle | null = null;
  let device: DeviceAgent | null = null;

  afterEach(() => {
    device?.disconnect();
    device = null;
    handle?.stop();
    handle = null;
  });

  it("runs the full local loop: register, spawn agent, agent auth", async () => {
    const home = tempHome();
    handle = await startLocalBroker(home, "/install/mcp/dist/main.js");

    // Sockets live under home/run like every other flow.
    expect(handle.agentSocket).toBe(path.join(home, "run/agent.sock"));
    expect(fs.existsSync(handle.agentSocket)).toBe(true);
    expect(fs.existsSync(handle.deviceSocket)).toBe(true);

    // The app's device agent connects over the device socket and registers —
    // sharing `home` with the broker exactly as the app does in local mode.
    device = new DeviceAgent(home, "TestMac", approveAll);
    await device.connectUnix(handle.deviceSocket);
    expect(handle.broker.isDeviceOnline(device.identity.deviceId)).toBe(true);

    // The audit log is the oracle: the device recorded its start.
    const audit = fs.readFileSync(path.join(home, "device/audit.ndjson"), "utf8");
    expect(audit).toContain("device_started");

    // "Start agent" provisioning points the agent at the LOCAL Unix socket
    // and advertises the shim path the broker was started with.
    const spawned = jv(await device.requestSpawnAgent("check disk space"));
    expect(spawned.get("socket").str).toBe(handle.agentSocket);
    expect(spawned.get("mcp_command").str).toBe("/install/mcp/dist/main.js");
    const token = spawned.get("token").str;
    expect(token).toBeTruthy();

    // An agent (what the domo-mcp shim does) authenticates on the agent socket.
    const reply = await requestLine(
      handle.agentSocket,
      canonicalBytes({ type: "domo-auth", token }),
    );
    expect(jv(parseJSON(reply)).get("type").str).toBe("domo-auth-ok");
  });

  it("stop() unlinks both sockets so nothing is left behind", async () => {
    const home = tempHome();
    handle = await startLocalBroker(home, null);
    const { agentSocket, deviceSocket } = handle;
    handle.stop();
    handle = null;
    expect(fs.existsSync(agentSocket)).toBe(false);
    expect(fs.existsSync(deviceSocket)).toBe(false);
  });

  it("falls back to a short socket dir when home would exceed the Unix limit", () => {
    const deepHome = "/Users/someone/" + "deeply-nested/".repeat(8) + "Domo";
    const paths = localSocketPaths(deepHome);
    expect(paths.agentSocket.length).toBeLessThanOrEqual(100);
    expect(paths.deviceSocket.length).toBeLessThanOrEqual(100);
    // Deterministic: restarts land on the same fallback dir.
    expect(localSocketPaths(deepHome)).toEqual(paths);
    // Distinct homes get distinct fallback dirs.
    expect(localSocketPaths(deepHome + "2").agentSocket).not.toBe(paths.agentSocket);
  });
});
