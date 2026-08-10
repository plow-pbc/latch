/**
 * One authenticated agent connection speaking MCP (JSON-RPC 2.0, one message
 * per line) — twin of DomoBrokerCore/MCPSession.swift. Translates tool calls
 * into signed intents routed to devices.
 */
import crypto from "node:crypto";
import {
  Capability,
  canonicalBytes,
  canonicalJSON,
  Intent,
  JSONValue,
  jv,
  makeIntent,
  signIntent,
} from "@domo/protocol";
import { Connection } from "@domo/transport";
import type { Broker, DeviceLink } from "./broker.js";
import { AgentRecord, agentKeyPair } from "./store.js";

class ToolError extends Error {}

export class MCPSession {
  private readonly sessionId = crypto.randomUUID().toUpperCase();

  constructor(
    private readonly broker: Broker,
    private readonly conn: Connection,
    private readonly agentToken: string,
  ) {}

  private get agent(): AgentRecord | null {
    return this.broker.store.agent(this.agentToken);
  }

  /** The agent identity bound to this session, for revocation targeting. */
  get boundAgentId(): string | null {
    return this.agent?.agentId ?? null;
  }

  closeSession(): void {
    this.conn.close();
  }

  handleLine(line: Buffer): void {
    let message: JSONValue;
    try {
      message = JSON.parse(line.toString("utf8")) as JSONValue;
    } catch {
      return;
    }
    const m = jv(message);
    const id = m.get("id").value ?? null;
    const method = m.get("method").str;
    if (method === null) return;
    if (id === null) return; // notifications (e.g. notifications/initialized)
    void this.dispatch(method, m.get("params").value ?? null).then(
      (result) => this.send({ jsonrpc: "2.0", id, result }),
      (error: unknown) =>
        this.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        }),
    );
  }

  private send(message: JSONValue): void {
    this.conn.sendLine(canonicalBytes(message));
  }

  private async dispatch(method: string, params: JSONValue): Promise<JSONValue> {
    switch (method) {
      case "initialize": {
        const requested = jv(params).get("protocolVersion").str ?? "2024-11-05";
        return {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: "domo-broker", version: "0.1.0" },
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: MCP_TOOLS };
      case "tools/call": {
        const name = jv(params).get("name").str;
        if (name === null) throw new Error("missing tool name");
        return this.callTool(name, jv(params).get("arguments").value ?? null);
      }
      default:
        throw new Error(`method not supported: ${method}`);
    }
  }

  // MARK: Tool dispatch

  private async callTool(name: string, args: JSONValue): Promise<JSONValue> {
    try {
      const result = await this.runTool(name, args);
      return {
        content: [{ type: "text", text: canonicalJSON(result) }],
        isError: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  private async runTool(name: string, args: JSONValue): Promise<JSONValue> {
    switch (name) {
      case "list_devices":
        return this.listDevices();
      case "request_device_access":
        return this.requestAccess(args);
      case "read_file":
        return this.readFile(args);
      case "write_file":
        return this.writeFile(args);
      case "run_command":
        return this.runCommand(args);
      case "get_output":
        return this.getOutput(args);
      case "list_device_tools":
        return this.listDeviceTools(args);
      case "use_tool":
        return this.useTool(args);
      default:
        throw new ToolError(`unknown tool: ${name}`);
    }
  }

  private requireAgent(): AgentRecord {
    const agent = this.agent;
    if (!agent) throw new ToolError("agent identity revoked");
    if (this.broker.store.isRevoked(agent.agentId)) {
      throw new ToolError("agent access has been revoked");
    }
    return agent;
  }

  private requireGrantedLink(args: JSONValue): {
    agent: AgentRecord;
    deviceId: string;
    link: DeviceLink;
  } {
    const agent = this.requireAgent();
    const deviceId = jv(args).get("device").str;
    if (deviceId === null) throw new ToolError("missing 'device'");
    if (!agent.grantedDevices.includes(deviceId)) {
      throw new ToolError(`no grant for device ${deviceId}; call request_device_access first`);
    }
    const link = this.broker.deviceLink(deviceId);
    if (!link) throw new ToolError(`device ${deviceId} is offline`);
    return { agent, deviceId, link };
  }

  private listDevices(): JSONValue {
    const agent = this.requireAgent();
    const online = this.broker.onlineDeviceIds();
    return {
      devices: this.broker.store.allDevices().map((device) => ({
        id: device.deviceId,
        name: device.name,
        online: online.has(device.deviceId),
        granted: agent.grantedDevices.includes(device.deviceId),
      })),
    };
  }

  private async requestAccess(args: JSONValue): Promise<JSONValue> {
    const agent = this.requireAgent();
    const a = jv(args);
    const deviceId = a.get("device").str;
    if (deviceId === null) throw new ToolError("missing 'device'");
    const goals = a.get("goals").str;
    if (goals === null || goals.length === 0) {
      throw new ToolError("missing 'goals' — state what you intend to do on this Mac");
    }
    const link = this.broker.deviceLink(deviceId);
    if (!link) throw new ToolError(`device ${deviceId} is offline`);
    if (agent.grantedDevices.includes(deviceId)) {
      return { status: "granted", note: "already granted" };
    }
    // Approval can take as long as a human takes; generous timeout.
    const response = await link.rpc.call(
      "access_request",
      {
        agent: {
          id: agent.agentId,
          display: agent.display,
          publicKey: agent.publicKeyBase64,
        },
        goals,
      },
      600,
    );
    const approved = jv(response).get("approved").bool ?? false;
    if (approved) {
      this.broker.store.grantDevice(this.agentToken, deviceId);
      this.broker.store.recordSessionGoals(this.agentToken, goals);
    }
    return { status: approved ? "granted" : "denied" };
  }

  // MARK: Intent construction

  private makeSignedIntent(
    agent: AgentRecord,
    deviceId: string,
    goal: string | undefined,
    request: string,
    capabilities: Capability[],
  ): Intent {
    const intent = makeIntent({
      agentId: agent.agentId,
      agentDisplay: agent.display,
      agentPublicKey: agent.publicKeyBase64,
      deviceId,
      goal,
      planContext: agent.sessionGoals,
      request,
      capabilities,
      sessionId: this.sessionId,
    });
    signIntent(intent, agentKeyPair(agent));
    return intent;
  }

  private async sendIntent(
    intent: Intent,
    payload: JSONValue,
    link: DeviceLink,
    timeoutSeconds = 630,
  ): Promise<JSONValue> {
    const response = await link.rpc.call(
      "intent",
      { intent: intent as unknown as JSONValue, payload },
      timeoutSeconds,
    );
    const status = jv(response).get("status").str;
    if (status === "denied") throw new ToolError("the device owner denied this request");
    if (status === "rejected") {
      throw new ToolError(
        `device rejected intent: ${jv(response).get("reason").str ?? "unknown"}`,
      );
    }
    if (status === "error") {
      throw new ToolError(jv(response).get("error").str ?? "device error");
    }
    return response;
  }

  // MARK: Tools

  private async readFile(args: JSONValue): Promise<JSONValue> {
    const { agent, deviceId, link } = this.requireGrantedLink(args);
    const path = jv(args).get("path").str;
    if (path === null) throw new ToolError("missing 'path'");
    const intent = this.makeSignedIntent(
      agent,
      deviceId,
      jv(args).get("goal").str ?? undefined,
      `read file: ${path}`,
      [{ kind: "fs.read", paths: [path] }],
    );
    const response = await this.sendIntent(intent, null, link);
    const base64 = jv(response).get("content_base64").str;
    if (base64 === null) throw new ToolError("device returned no content");
    const data = Buffer.from(base64, "base64");
    const text = data.toString("utf8");
    // Return text when it round-trips as UTF-8, base64 otherwise (binary safety).
    if (Buffer.from(text, "utf8").equals(data)) {
      return { path, content: text };
    }
    return { path, content_base64: base64 };
  }

  private async writeFile(args: JSONValue): Promise<JSONValue> {
    const { agent, deviceId, link } = this.requireGrantedLink(args);
    const a = jv(args);
    const path = a.get("path").str;
    if (path === null) throw new ToolError("missing 'path'");
    const content = a.get("content").str;
    if (content === null) throw new ToolError("missing 'content'");
    const data = Buffer.from(content, "utf8");
    const intent = this.makeSignedIntent(
      agent,
      deviceId,
      a.get("goal").str ?? undefined,
      `write file: ${path} (${data.length} bytes)`,
      [{ kind: "fs.write", paths: [path] }],
    );
    const response = await this.sendIntent(
      intent,
      { content_base64: data.toString("base64") },
      link,
    );
    return { path, bytes: jv(response).get("bytes").value ?? null };
  }

  private async runCommand(args: JSONValue): Promise<JSONValue> {
    const { agent, deviceId, link } = this.requireGrantedLink(args);
    const a = jv(args);
    const argvValues = a.get("argv").arr;
    if (!argvValues || argvValues.length === 0) throw new ToolError("missing 'argv'");
    const argv = argvValues.filter((v): v is string => typeof v === "string");
    if (argv.length !== argvValues.length) throw new ToolError("argv must be strings");
    const readPaths = (a.get("read_paths").arr ?? []).filter(
      (v): v is string => typeof v === "string",
    );
    const writePaths = (a.get("write_paths").arr ?? []).filter(
      (v): v is string => typeof v === "string",
    );
    const network = a.get("network").bool ?? false;
    const waitMs = a.get("wait_ms").int ?? 10000;

    const capabilities: Capability[] = [
      { kind: "process.exec", argv, cwd: a.get("cwd").str ?? undefined },
      { kind: "network", allowed: network },
    ];
    if (readPaths.length > 0) capabilities.push({ kind: "fs.read", paths: readPaths });
    if (writePaths.length > 0) capabilities.push({ kind: "fs.write", paths: writePaths });

    const intent = this.makeSignedIntent(
      agent,
      deviceId,
      a.get("goal").str ?? undefined,
      `run: ${argv.join(" ")}`,
      capabilities,
    );
    return this.sendIntent(intent, { wait_ms: waitMs }, link, waitMs / 1000 + 630);
  }

  private async getOutput(args: JSONValue): Promise<JSONValue> {
    const { link } = this.requireGrantedLink(args);
    const handle = jv(args).get("handle").str;
    if (handle === null) throw new ToolError("missing 'handle'");
    // Output retrieval is bound to an already-approved run; no new intent.
    return link.rpc.call(
      "get_output",
      { handle, since: jv(args).get("since").int ?? 0 },
      30,
    );
  }

  private listDeviceTools(args: JSONValue): JSONValue {
    const { link } = this.requireGrantedLink(args);
    return { tools: link.blessedTools };
  }

  private async useTool(args: JSONValue): Promise<JSONValue> {
    const { agent, deviceId, link } = this.requireGrantedLink(args);
    const tool = jv(args).get("tool").str;
    if (tool === null) throw new ToolError("missing 'tool'");
    const intent = this.makeSignedIntent(
      agent,
      deviceId,
      jv(args).get("goal").str ?? undefined,
      `use blessed tool: ${tool}`,
      [{ kind: "tool", tool }],
    );
    const response = await this.sendIntent(
      intent,
      { args: jv(args).get("args").value ?? null },
      link,
    );
    return { result: jv(response).get("result").value ?? null };
  }
}

/** Static MCP tool definitions (DESIGN.md §3) — verbatim from the Swift broker. */
export const MCP_TOOLS: JSONValue = [
  {
    name: "list_devices",
    description:
      "List the Macs visible to this agent: id, name, online status, and whether you already hold an access grant.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "request_device_access",
    description:
      "Ask a Mac's owner for permission to use it. State your goals honestly — the owner sees them. Returns granted or denied.",
    inputSchema: {
      type: "object",
      required: ["device", "goals"],
      properties: {
        device: { type: "string", description: "Device id from list_devices" },
        goals: { type: "string", description: "What you intend to do on this Mac and why" },
      },
    },
  },
  {
    name: "read_file",
    description: "Read a file on a granted Mac. The owner may be asked to approve.",
    inputSchema: {
      type: "object",
      required: ["device", "path"],
      properties: {
        device: { type: "string" },
        path: { type: "string", description: "Absolute path (~ allowed)" },
        goal: { type: "string", description: "Why you need this file (shown to the approver)" },
      },
    },
  },
  {
    name: "write_file",
    description: "Write a file on a granted Mac. The owner may be asked to approve.",
    inputSchema: {
      type: "object",
      required: ["device", "path", "content"],
      properties: {
        device: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        goal: { type: "string", description: "Why (shown to the approver)" },
      },
    },
  },
  {
    name: "run_command",
    description:
      "Run a CLI command on a granted Mac inside a sandbox limited to the paths you declare here. Declare every path you need up front; undeclared paths are blocked by the sandbox. Waits up to wait_ms; if still running you get a handle for get_output.",
    inputSchema: {
      type: "object",
      required: ["device", "argv"],
      properties: {
        device: { type: "string" },
        argv: {
          type: "array",
          items: { type: "string" },
          description: 'Command and arguments, e.g. ["ls", "-la", "/tmp"]',
        },
        cwd: { type: "string", description: "Working directory (readable by the sandbox)" },
        read_paths: {
          type: "array",
          items: { type: "string" },
          description: "Directories/files the command may read",
        },
        write_paths: {
          type: "array",
          items: { type: "string" },
          description: "Directories/files the command may write",
        },
        network: {
          type: "boolean",
          description: "Whether the command needs network access (default false)",
        },
        wait_ms: {
          type: "integer",
          description: "How long to wait for completion before returning a handle (default 10000)",
        },
        goal: { type: "string", description: "Why (shown to the approver)" },
      },
    },
  },
  {
    name: "get_output",
    description:
      "Fetch incremental output of a still-running command. Pass 'since' = the output_length you last saw.",
    inputSchema: {
      type: "object",
      required: ["device", "handle"],
      properties: {
        device: { type: "string" },
        handle: { type: "string" },
        since: { type: "integer" },
      },
    },
  },
  {
    name: "list_device_tools",
    description:
      "List the blessed tools available on a specific Mac, with their JSON input schemas. Different Macs have different tools.",
    inputSchema: {
      type: "object",
      required: ["device"],
      properties: { device: { type: "string" } },
    },
  },
  {
    name: "use_tool",
    description: "Invoke a blessed tool on a granted Mac (discover them with list_device_tools).",
    inputSchema: {
      type: "object",
      required: ["device", "tool"],
      properties: {
        device: { type: "string" },
        tool: { type: "string" },
        args: { type: "object" },
        goal: { type: "string", description: "Why (shown to the approver)" },
      },
    },
  },
];
