/**
 * "Local mode" — the app runs the broker itself, in-process, over Unix domain
 * sockets. No network listener, no TLS, nothing outlives the app: the broker
 * dies with the Electron main process, and stop() closes both listeners and
 * unlinks the socket files. Kept free of Electron imports so it is
 * unit-testable under plain vitest.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DomoPaths } from "@domo/protocol";
import { Broker } from "@domo/broker-core";

/** macOS caps sun_path at 104 bytes; stay comfortably under it. */
const MAX_SOCKET_PATH = 100;

export interface LocalSocketPaths {
  agentSocket: string;
  deviceSocket: string;
}

/**
 * Socket paths for a local broker under `home` — normally home/run/*.sock
 * (the same layout every other flow uses). If home is deep enough that a
 * socket path would exceed the Unix limit, fall back to a short, per-home
 * directory under the system temp dir (deterministic, so restarts reuse it).
 */
export function localSocketPaths(home: string): LocalSocketPaths {
  const agent = DomoPaths.agentSocket(home);
  const device = DomoPaths.deviceSocket(home);
  if (Math.max(agent.length, device.length) <= MAX_SOCKET_PATH) {
    return { agentSocket: agent, deviceSocket: device };
  }
  const hash = crypto.createHash("sha256").update(home).digest("hex").slice(0, 8);
  const dir = path.join(os.tmpdir(), `domo-${hash}`);
  return {
    agentSocket: path.join(dir, "agent.sock"),
    deviceSocket: path.join(dir, "device.sock"),
  };
}

export interface LocalBrokerHandle {
  readonly broker: Broker;
  readonly agentSocket: string;
  readonly deviceSocket: string;
  /** Close both listeners, drop live connections, unlink the socket files. */
  stop(): void;
}

/**
 * Start an in-process broker for local mode. Broker state lives under the
 * same `home` the app already uses (home/broker), matching the shared-home
 * layout of the networked flow. `mcpShimPath` is advertised in spawn_agent
 * responses so "Start agent" can wire Claude Code to the local agent socket.
 */
export async function startLocalBroker(
  home: string,
  mcpShimPath: string | null,
): Promise<LocalBrokerHandle> {
  const { agentSocket, deviceSocket } = localSocketPaths(home);
  fs.mkdirSync(path.dirname(agentSocket), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(deviceSocket), { recursive: true, mode: 0o700 });
  const broker = Broker.overUnixSockets(home, agentSocket, deviceSocket);
  if (mcpShimPath) broker.mcpShimPath = mcpShimPath;
  await broker.start();
  return {
    broker,
    agentSocket,
    deviceSocket,
    stop: () => broker.stop(),
  };
}
