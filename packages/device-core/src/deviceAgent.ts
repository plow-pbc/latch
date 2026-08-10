/**
 * The device-side engine — twin of DomoDeviceCore/DeviceAgent.swift:
 * registers with the broker, receives access requests and intents, runs them
 * through policy, executes approved operations, and audits everything.
 * Shared by the headless runner and the Electron app.
 */
import {
  canonicalBytes,
  capabilityDisplay,
  DeviceChallenge,
  Intent,
  intentIsExpired,
  JSONValue,
  jv,
  verifyIntentSignature,
} from "@domo/protocol";
import {
  Connection,
  ConnectionDialer,
  LineRPC,
  RPCError,
  UnixSocketDialer,
} from "@domo/transport";
import path from "node:path";
import { AuditLog } from "./auditLog.js";
import { BlessedToolRegistry } from "./blessedTools.js";
import { Executor } from "./executor.js";
import { FileOps } from "./fileOps.js";
import { DeviceIdentity, KnownAgents, loadOrCreateIdentity } from "./identity.js";
import { PolicyDelegate, PolicyEngine } from "./policyEngine.js";

export class DeviceAgent {
  readonly identity: DeviceIdentity;
  readonly audit: AuditLog;
  readonly policy: PolicyEngine;
  readonly blessedTools: BlessedToolRegistry;
  readonly executor: Executor;
  private readonly knownAgents: KnownAgents;
  private rpc: LineRPC | null = null;
  private readonly seenNonces = new Set<string>();

  // Reconnect state (networked transport only).
  private dialer: ConnectionDialer | null = null;
  private shouldReconnect = false;
  private authenticate = false;
  private backoff = 0.5;
  private reconnectTimer: NodeJS.Timeout | null = null;

  onConnectionClosed: (() => void) | null = null;
  onConnected: (() => void) | null = null;
  onLinkDown: (() => void) | null = null;

  constructor(
    public readonly home: string,
    name: string,
    private readonly delegate: PolicyDelegate,
    blessedTools?: BlessedToolRegistry,
  ) {
    this.identity = loadOrCreateIdentity(home, name);
    this.audit = new AuditLog(path.join(home, "device/audit.ndjson"));
    this.policy = new PolicyEngine(path.join(home, "device/rules.json"));
    this.knownAgents = new KnownAgents(path.join(home, "device/known_agents.json"));
    this.executor = new Executor(path.join(home, "device/scratch"));
    this.blessedTools = blessedTools ?? BlessedToolRegistry.standard();
  }

  /** v1 convenience: local Unix socket, fail fast, no reconnect. */
  connectUnix(brokerSocket: string): Promise<void> {
    return this.connect(new UnixSocketDialer(brokerSocket));
  }

  /**
   * Connect over any transport. `reconnect` re-dials with exponential backoff
   * and re-registers — nothing above LineRPC changes (runbook Phase 1).
   */
  async connect(dialer: ConnectionDialer, reconnect = false, authenticate = false): Promise<void> {
    this.dialer = dialer;
    this.shouldReconnect = reconnect;
    this.authenticate = authenticate;
    if (reconnect) {
      try {
        await this.establish();
      } catch {
        this.scheduleReconnect();
      }
    } else {
      await this.establish();
    }
  }

  private async establish(): Promise<void> {
    const conn = await this.dialer!.connect();
    if (this.authenticate) {
      await this.performChallenge(conn);
    }
    const rpc = new LineRPC(conn);
    this.rpc = rpc;
    rpc.register("access_request", (params) => this.handleAccessRequest(params));
    rpc.register("intent", (params) => this.handleIntent(params));
    rpc.register("get_output", async (params) => this.handleGetOutput(params));
    rpc.register("revoke_agent", async (params) => {
      const agentId = jv(params).get("agent").str;
      if (agentId === null) throw new RPCError("revoke_agent requires an agent id");
      this.revokeAgent(agentId);
      return { ok: true };
    });
    rpc.onClose = () => this.handleDisconnect();
    if (!this.authenticate) rpc.start();
    // (After the challenge the read loop is already running.)
    await rpc.call("register", {
      device: {
        id: this.identity.deviceId,
        name: this.identity.name,
        publicKey: this.identity.keyPair.publicKeyBase64,
      },
      blessedTools: this.blessedTools.manifest(),
    });
    this.backoff = 0.5;
    this.audit.record("device_started", { device: this.identity.deviceId });
    this.onConnected?.();
  }

  /** Answer the broker's connect challenge before LineRPC takes over. */
  private performChallenge(conn: Connection): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.close();
        reject(new RPCError("challenge timed out"));
      }, 15_000);
      timer.unref?.();
      conn.onLine = (line) => {
        let msg: JSONValue;
        try {
          msg = JSON.parse(line.toString("utf8")) as JSONValue;
        } catch {
          return;
        }
        const m = jv(msg);
        switch (m.get("type").str) {
          case "challenge": {
            const nonce = m.get("nonce").str;
            if (nonce === null) return;
            conn.sendLine(
              canonicalBytes({
                type: "challenge-response",
                deviceId: this.identity.deviceId,
                publicKey: this.identity.keyPair.publicKeyBase64,
                signature: DeviceChallenge.sign(nonce, this.identity.keyPair),
              }),
            );
            break;
          }
          case "auth-ok":
            clearTimeout(timer);
            resolve();
            break;
          case "auth-error":
            clearTimeout(timer);
            reject(
              new RPCError(`enrollment challenge rejected: ${m.get("reason").str ?? ""}`),
            );
            break;
        }
      };
      conn.startReading();
    });
  }

  private handleDisconnect(): void {
    this.onLinkDown?.();
    if (!this.shouldReconnect) {
      this.onConnectionClosed?.();
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30);
    this.reconnectTimer = setTimeout(() => {
      if (!this.shouldReconnect) return;
      void this.establish().catch(() => this.scheduleReconnect());
    }, delay * 1000);
    this.reconnectTimer.unref?.();
  }

  /** Stop reconnecting and drop the current link. */
  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.rpc?.close();
  }

  /** Agent ids currently trusted (pinned, not revoked). */
  knownAgentIds(): string[] {
    return this.knownAgents.pinnedAgentIds();
  }

  /** Submit a pairing request to an enrollment broker (one-shot connection). */
  async pair(dialer: ConnectionDialer, code: string, timeoutSeconds = 15): Promise<boolean> {
    const conn = await dialer.connect();
    const acknowledged = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutSeconds * 1000);
      timer.unref?.();
      conn.onLine = (line) => {
        try {
          const msg = jv(JSON.parse(line.toString("utf8")) as JSONValue);
          if (msg.get("type").str === "pair-pending") {
            clearTimeout(timer);
            resolve(true);
          }
        } catch {
          /* ignore */
        }
      };
      conn.startReading();
      conn.sendLine(
        canonicalBytes({
          type: "pair",
          code,
          deviceId: this.identity.deviceId,
          publicKey: this.identity.keyPair.publicKeyBase64,
          name: this.identity.name,
        }),
      );
    });
    conn.close();
    this.audit.record("pairing_requested", { device: this.identity.deviceId, code });
    return acknowledged;
  }

  /**
   * Ask the broker to mint a pre-approved agent for a goal (Mac-initiated
   * spin-up). The user launching this IS the approval, so the new agent's key
   * is pinned immediately.
   */
  async requestSpawnAgent(goal: string, timeoutSeconds = 15): Promise<JSONValue> {
    if (!this.rpc) throw new RPCError("not connected");
    const response = await this.rpc.call("spawn_agent", { goal }, timeoutSeconds);
    const agentId = jv(response).get("agent_id").str;
    const publicKey = jv(response).get("public_key").str;
    if (agentId !== null && publicKey !== null) {
      this.knownAgents.pin(agentId, publicKey);
      this.audit.record("agent_spawned", { agent: agentId, goal });
    }
    return response;
  }

  // MARK: Handlers

  private async handleAccessRequest(params: JSONValue): Promise<JSONValue> {
    const p = jv(params);
    const agentId = p.get("agent").get("id").str ?? "?";
    const display = p.get("agent").get("display").str ?? agentId;
    const publicKey = p.get("agent").get("publicKey").str ?? "";
    const goals = p.get("goals").str ?? "";
    this.audit.record("access_request", { agent: agentId, display, goals });
    const approved = await this.delegate.decideAccess(agentId, display, goals);
    if (approved) {
      this.knownAgents.pin(agentId, publicKey);
    }
    this.audit.record("access_decision", { agent: agentId, approved });
    return { approved };
  }

  private async handleIntent(params: JSONValue): Promise<JSONValue> {
    const intentValue = jv(params).get("intent").value;
    if (intentValue === null || typeof intentValue !== "object" || Array.isArray(intentValue)) {
      throw new RPCError("malformed intent");
    }
    const intent = intentValue as unknown as Intent;
    const payload = jv(params).get("payload").value ?? null;

    const failure = this.validate(intent);
    if (failure !== null) {
      this.audit.record("intent_rejected", { intentId: intent.intentId, reason: failure });
      return { status: "rejected", reason: failure };
    }

    this.audit.record("intent_received", {
      intentId: intent.intentId,
      agent: intent.agentId,
      request: intent.request,
      goal: intent.goal ?? "",
      capabilities: intent.capabilities.map(capabilityDisplay),
    });

    const grant = await this.policy.decide(intent, this.delegate);
    this.audit.record("intent_decision", {
      intentId: intent.intentId,
      decision: grant.decision,
      source: grant.source,
    });
    if (grant.decision === "deny") {
      return { status: "denied" };
    }
    return this.execute(intent, payload);
  }

  /** Revoke an agent locally and authoritatively (runbook Phase 5). */
  revokeAgent(agentId: string): void {
    this.knownAgents.revoke(agentId);
    this.audit.record("agent_revoked", { agent: agentId });
  }

  private validate(intent: Intent): string | null {
    if (intent.deviceId !== this.identity.deviceId) return "wrong device";
    if (intentIsExpired(intent)) return "expired";
    if (this.knownAgents.isRevoked(intent.agentId)) return "revoked agent";
    if (this.seenNonces.has(intent.nonce)) return "replayed nonce";
    this.seenNonces.add(intent.nonce);
    const pinned = this.knownAgents.publicKeyFor(intent.agentId);
    if (pinned === null) return "unknown agent (no access grant)";
    if (pinned !== intent.agentPublicKey) return "public key mismatch";
    if (!verifyIntentSignature(intent)) return "bad signature";
    return null;
  }

  // MARK: Execution

  private async execute(intent: Intent, payload: JSONValue): Promise<JSONValue> {
    const exec = intent.capabilities.find((c) => c.kind === "process.exec");
    if (exec) return this.executeCommand(intent, exec, payload);
    const toolCap = intent.capabilities.find((c) => c.kind === "tool");
    if (toolCap) return this.executeTool(intent, toolCap, payload);
    const write = intent.capabilities.find((c) => c.kind === "fs.write");
    if (write) return this.executeWrite(intent, write, payload);
    const read = intent.capabilities.find((c) => c.kind === "fs.read");
    if (read) return this.executeRead(intent, read);
    return { status: "error", error: "no executable capability in intent" };
  }

  private executeRead(intent: Intent, cap: { paths?: string[] }): JSONValue {
    const p = cap.paths?.[0];
    if (p === undefined) return { status: "error", error: "missing path" };
    try {
      const data = FileOps.read(p, cap.paths ?? []);
      this.audit.record("file_read", {
        intentId: intent.intentId,
        path: p,
        bytes: data.length,
      });
      return {
        status: "completed",
        content_base64: data.toString("base64"),
        bytes: data.length,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.record("denied_operation", { intentId: intent.intentId, path: p, error: message });
      return { status: "error", error: message };
    }
  }

  private executeWrite(intent: Intent, cap: { paths?: string[] }, payload: JSONValue): JSONValue {
    const p = cap.paths?.[0];
    if (p === undefined) return { status: "error", error: "missing path" };
    const contentBase64 = jv(payload).get("content_base64").str;
    if (contentBase64 === null) return { status: "error", error: "missing content" };
    const data = Buffer.from(contentBase64, "base64");
    try {
      FileOps.write(p, data, cap.paths ?? []);
      this.audit.record("file_write", {
        intentId: intent.intentId,
        path: p,
        bytes: data.length,
      });
      return { status: "completed", bytes: data.length };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.record("denied_operation", { intentId: intent.intentId, path: p, error: message });
      return { status: "error", error: message };
    }
  }

  private async executeCommand(
    intent: Intent,
    exec: { argv?: string[]; cwd?: string },
    payload: JSONValue,
  ): Promise<JSONValue> {
    const readPaths = intent.capabilities.find((c) => c.kind === "fs.read")?.paths ?? [];
    const writePaths = intent.capabilities.find((c) => c.kind === "fs.write")?.paths ?? [];
    const network = intent.capabilities.find((c) => c.kind === "network")?.allowed ?? false;
    // wait_ms is delivery detail, not an approved capability, so it rides in
    // the payload rather than the signed intent.
    const waitMs = jv(payload).get("wait_ms").int ?? 10000;
    this.audit.record("exec_start", { intentId: intent.intentId, argv: exec.argv ?? [] });
    try {
      const result = await this.executor.run({
        argv: exec.argv ?? [],
        cwd: exec.cwd,
        readPaths,
        writePaths,
        network,
        waitMs,
      });
      if (!result.running) {
        this.audit.record("exec_end", {
          intentId: intent.intentId,
          exit_code: result.exitCode ?? -1,
        });
      }
      const response: { [k: string]: JSONValue } = {
        status: result.running ? "running" : "completed",
        handle: result.handle,
        output: result.output.toString("utf8"),
        output_length: result.outputLength,
      };
      if (result.exitCode !== null) response.exit_code = result.exitCode;
      return response;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.record("exec_error", { intentId: intent.intentId, error: message });
      return { status: "error", error: message };
    }
  }

  private async executeTool(
    intent: Intent,
    toolCap: { tool?: string },
    payload: JSONValue,
  ): Promise<JSONValue> {
    const name = toolCap.tool;
    const tool = name !== undefined ? this.blessedTools.tool(name) : null;
    if (!tool || name === undefined) return { status: "error", error: "unknown tool" };
    try {
      const result = await tool.invoke(jv(payload).get("args").value ?? null);
      this.audit.record("tool_invoked", { intentId: intent.intentId, tool: name });
      return { status: "completed", result };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.record("tool_error", { intentId: intent.intentId, tool: name, error: message });
      return { status: "error", error: message };
    }
  }

  private handleGetOutput(params: JSONValue): JSONValue {
    const handle = jv(params).get("handle").str;
    if (handle === null) throw new RPCError("missing handle");
    const since = jv(params).get("since").int ?? 0;
    const result = this.executor.output(handle, since);
    if (!result.running && result.exitCode !== null) {
      this.audit.record("exec_end", { handle, exit_code: result.exitCode });
    }
    const response: { [k: string]: JSONValue } = {
      status: result.running ? "running" : "completed",
      output: result.output.toString("utf8"),
      output_length: result.outputLength,
    };
    if (result.exitCode !== null) response.exit_code = result.exitCode;
    return response;
  }
}
