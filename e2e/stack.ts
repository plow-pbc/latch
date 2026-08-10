/**
 * E2E harness. Boots a real broker process + real headless device process in a
 * throwaway DOMO_HOME, and provides an MCP client speaking JSON-RPC over the
 * agent socket, exactly the way the domo-mcp shim + Claude Code would. The
 * broker/device binaries are selectable (BinaryConfig) so alternate
 * configurations can be added without changing the scenarios.
 */
import { ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalBytes,
  JSONValue,
  jv,
  parseJSON,
} from "@domo/protocol";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export interface BinaryConfig {
  /** How to launch domo-broker: argv prefix (e.g. ["node", ".../main.js"]). */
  broker: string[];
  /** How to launch domo-device. */
  device: string[];
}

export const TS_BROKER = ["node", path.join(repoRoot, "apps/broker/dist/main.js")];
export const TS_DEVICE = ["node", path.join(repoRoot, "apps/device/dist/main.js")];

function waitForSocket(sockPath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(sockPath);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`socket ${sockPath} never appeared`));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

export class TestStack {
  readonly home: string;
  readonly agentSocket: string;
  readonly deviceSocket: string;
  private brokerProc: ChildProcess | null = null;
  private deviceProc: ChildProcess | null = null;
  deviceId = "";

  constructor(private readonly bin: BinaryConfig = { broker: TS_BROKER, device: TS_DEVICE }) {
    // Keep the socket path short (Unix sockets cap ~104 chars) — CLAUDE.md.
    this.home = path.join(os.tmpdir(), `de2e-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(this.home, { recursive: true });
    this.agentSocket = path.join(this.home, "a.sock");
    this.deviceSocket = path.join(this.home, "d.sock");
  }

  async createAgent(name: string): Promise<{ token: string; agentId: string }> {
    const output = await this.runToCompletion([
      ...this.bin.broker,
      "create-agent",
      "--home",
      this.home,
      "--name",
      name,
    ]);
    const parsed = jv(parseJSON(output));
    return { token: parsed.get("token").str!, agentId: parsed.get("agent_id").str! };
  }

  async startBroker(): Promise<void> {
    const [cmd, ...args] = this.bin.broker;
    this.brokerProc = spawn(
      cmd!,
      [...args, "--home", this.home, "--agent-socket", this.agentSocket, "--device-socket", this.deviceSocket],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    await waitForSocket(this.agentSocket);
    await waitForSocket(this.deviceSocket);
  }

  get deviceHome(): string {
    return path.join(this.home, "devhome");
  }

  async startDevice(opts: {
    policy?: JSONValue;
    name?: string;
    spawnGoal?: string;
    spawnTokenOut?: string;
  } = {}): Promise<void> {
    const policy = opts.policy ?? { access: "allow", intent: "allow_once" };
    const policyPath = path.join(this.home, `policy-${crypto.randomBytes(3).toString("hex")}.json`);
    fs.writeFileSync(policyPath, canonicalBytes(policy));
    const args = [
      "--home",
      this.deviceHome,
      "--broker",
      this.deviceSocket,
      "--name",
      opts.name ?? "TestMac",
      "--policy",
      policyPath,
    ];
    if (opts.spawnGoal !== undefined) args.push("--spawn-goal", opts.spawnGoal);
    if (opts.spawnTokenOut !== undefined) args.push("--spawn-token-out", opts.spawnTokenOut);

    const [cmd, ...binArgs] = this.bin.device;
    this.deviceProc = spawn(cmd!, [...binArgs, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    // Wait for "domo-device ready id=<id>".
    this.deviceId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("device did not become ready")), 15_000);
      let buffer = "";
      this.deviceProc!.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const m = buffer.match(/ready id=(\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
    });
  }

  get deviceAuditPath(): string {
    return path.join(this.deviceHome, "device/audit.ndjson");
  }

  auditEvents(): JSONValue[] {
    let data: string;
    try {
      data = fs.readFileSync(this.deviceAuditPath, "utf8");
    } catch {
      return [];
    }
    return data
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => parseJSON(l));
  }

  private runToCompletion(argv: string[]): Promise<string> {
    const [cmd, ...args] = argv;
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd!, args, { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      proc.stdout!.on("data", (c: Buffer) => (out += c.toString("utf8")));
      proc.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
      proc.on("error", reject);
    });
  }

  async shutdown(): Promise<void> {
    this.deviceProc?.kill();
    this.brokerProc?.kill();
    await new Promise((r) => setTimeout(r, 100));
    try {
      fs.rmSync(this.home, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** A real MCP client: authenticates with the agent token, then speaks JSON-RPC. */
export class MCPTestClient {
  private socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, (msg: JSONValue) => void>();
  private nextId = 1;
  authOk = false;
  authRejected = false;
  private readyResolve: (() => void) | null = null;
  private readonly ready: Promise<void>;

  private constructor(sockPath: string) {
    this.socket = net.connect(sockPath);
    this.ready = new Promise((resolve) => (this.readyResolve = resolve));
    this.socket.on("data", (chunk) => this.onData(chunk));
  }

  static async connect(sockPath: string, token: string): Promise<MCPTestClient> {
    const client = new MCPTestClient(sockPath);
    await new Promise<void>((resolve, reject) => {
      client.socket.once("connect", resolve);
      client.socket.once("error", reject);
    });
    client.socket.write(Buffer.concat([canonicalBytes({ type: "domo-auth", token }), Buffer.from("\n")]));
    await Promise.race([
      client.ready,
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    return client;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let idx: number;
    while ((idx = this.buffer.indexOf(0x0a)) !== -1) {
      const line = this.buffer.subarray(0, idx);
      this.buffer = this.buffer.subarray(idx + 1);
      if (line.length === 0) continue;
      let message: JSONValue;
      try {
        message = parseJSON(line);
      } catch {
        continue;
      }
      const m = jv(message);
      const type = m.get("type").str;
      if (type !== null) {
        if (type === "domo-auth-ok") this.authOk = true;
        if (type === "domo-auth-error") this.authRejected = true;
        this.readyResolve?.();
        continue;
      }
      const id = m.get("id").int;
      if (id !== null) {
        const completion = this.pending.get(id);
        this.pending.delete(id);
        completion?.(message);
      }
    }
  }

  request(method: string, params: JSONValue = {}, timeoutMs = 30_000): Promise<JSONValue> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout on ${method}`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.socket.write(
        Buffer.concat([
          canonicalBytes({ jsonrpc: "2.0", id, method, params }),
          Buffer.from("\n"),
        ]),
      );
    });
  }

  async initializeSession(): Promise<void> {
    const response = jv(
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e", version: "0" },
      }),
    );
    if (response.get("result").get("serverInfo").get("name").str !== "domo-broker") {
      throw new Error("bad initialize response");
    }
  }

  /** Calls a tool; returns [parsed result JSON, isError]. */
  async callTool(
    name: string,
    args: JSONValue = {},
    timeoutMs = 60_000,
  ): Promise<[JSONValue, boolean]> {
    const response = jv(await this.request("tools/call", { name, arguments: args }, timeoutMs));
    if (!response.get("error").isNull) {
      throw new Error(`rpc error: ${JSON.stringify(response.get("error").value)}`);
    }
    const result = response.get("result");
    const isError = result.get("isError").bool ?? false;
    const text = result.get("content").get(0).get("text").str ?? "";
    let parsed: JSONValue;
    try {
      parsed = parseJSON(text);
    } catch {
      parsed = text;
    }
    return [parsed, isError];
  }

  close(): void {
    this.socket.destroy();
  }
}
