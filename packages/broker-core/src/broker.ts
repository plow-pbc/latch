/**
 * The rendezvous service — twin of DomoBrokerCore/Broker.swift: device
 * registry + agent identities/grants + message routing + the agent-facing MCP
 * endpoint. Same wire contract, so it interoperates with Swift devices and
 * the Swift domo-mcp shim.
 */
import fs from "node:fs";
import {
  canonicalBytes,
  DeviceChallenge,
  JSONValue,
  jv,
  KeyPair,
} from "@domo/protocol";
import {
  Connection,
  ConnectionListener,
  LineRPC,
  RPCError,
  SocketServer,
} from "@domo/transport";
import { BrokerStore, DeviceRecord } from "./store.js";
import { MCPSession } from "./mcpSession.js";

export interface DeviceLink {
  rpc: LineRPC;
  record: DeviceRecord;
  blessedTools: JSONValue;
}

export class Broker {
  readonly store: BrokerStore;
  private deviceLinks = new Map<string, DeviceLink>();
  private sessions = new Set<MCPSession>();
  private deviceRPCs = new Set<LineRPC>();
  /** Path to the domo-mcp shim, advertised in spawn_agent responses. */
  mcpShimPath: string | null = null;

  constructor(
    public readonly home: string,
    private readonly agentListener: ConnectionListener,
    private readonly deviceListener: ConnectionListener,
    /** The address agents dial — Unix socket path or ws(s):// URL. */
    public readonly agentEndpoint: string,
    /** Networked/hosted broker: devices must pass the connect challenge. */
    public readonly requireEnrollment = false,
  ) {
    this.store = new BrokerStore(home);
    fs.mkdirSync(home, { recursive: true });
    agentListener.onConnection = (conn) => this.acceptAgent(conn);
    deviceListener.onConnection = (conn) => this.acceptDevice(conn);
  }

  /** v1 convenience: local Unix domain sockets. */
  static overUnixSockets(home: string, agentSocket: string, deviceSocket: string): Broker {
    return new Broker(
      home,
      new SocketServer(agentSocket),
      new SocketServer(deviceSocket),
      agentSocket,
    );
  }

  async start(): Promise<void> {
    await this.agentListener.start();
    await this.deviceListener.start();
  }

  stop(): void {
    this.agentListener.stop();
    this.deviceListener.stop();
  }

  // MARK: Device side

  private acceptDevice(conn: Connection): void {
    if (!this.requireEnrollment) {
      this.setupDeviceRPC(conn);
      return;
    }
    // Networked broker: authenticate the device BEFORE any RPC.
    const nonce = DeviceChallenge.newNonce();
    conn.onLine = (line) => {
      const reject = (reason: string) => {
        conn.sendLine(canonicalBytes({ type: "auth-error", reason }));
        conn.close();
      };
      let msg: JSONValue;
      try {
        msg = JSON.parse(line.toString("utf8")) as JSONValue;
      } catch {
        reject("malformed message");
        return;
      }
      const m = jv(msg);
      const type = m.get("type").str;
      if (type === null) {
        reject("malformed message");
        return;
      }
      // Pairing request: record for provisioner approval, then close.
      if (type === "pair") {
        const code = m.get("code").str;
        const publicKey = m.get("publicKey").str;
        if (code === null || publicKey === null) {
          reject("malformed pair request");
          return;
        }
        const deviceId =
          m.get("deviceId").str ?? KeyPair.fingerprintOfPublicKeyBase64(publicKey);
        this.store.addPendingPairing(code, deviceId, m.get("name").str ?? "Mac", publicKey);
        conn.sendLine(canonicalBytes({ type: "pair-pending" }));
        conn.close();
        return;
      }
      const deviceId = m.get("deviceId").str;
      const publicKey = m.get("publicKey").str;
      const signature = m.get("signature").str;
      if (type !== "challenge-response" || deviceId === null || publicKey === null || signature === null) {
        reject("malformed challenge-response");
        return;
      }
      const enrolled = this.store.deviceById(deviceId);
      if (!enrolled || enrolled.publicKeyBase64 !== publicKey) {
        reject("device not enrolled");
        return;
      }
      if (!DeviceChallenge.verify(nonce, signature, publicKey)) {
        reject("bad challenge signature");
        return;
      }
      conn.sendLine(canonicalBytes({ type: "auth-ok" }));
      // Identity proven — hand off to the normal RPC path.
      this.setupDeviceRPC(conn);
    };
    conn.sendLine(canonicalBytes({ type: "challenge", nonce }));
  }

  private setupDeviceRPC(conn: Connection): void {
    const rpc = new LineRPC(conn);
    this.deviceRPCs.add(rpc);
    let registeredId: string | null = null;
    rpc.register("register", async (params) => {
      const p = jv(params);
      const id = p.get("device").get("id").str;
      const name = p.get("device").get("name").str;
      const publicKey = p.get("device").get("publicKey").str;
      if (id === null || name === null || publicKey === null) {
        throw new RPCError("malformed register");
      }
      const record: DeviceRecord = { deviceId: id, name, publicKeyBase64: publicKey };
      this.store.upsertDevice(record);
      this.deviceLinks.set(id, {
        rpc,
        record,
        blessedTools: p.get("blessedTools").value ?? null,
      });
      registeredId = id;
      return { ok: true };
    });
    rpc.register("spawn_agent", async (params) => {
      const goal = jv(params).get("goal").str;
      const deviceId = registeredId;
      if (goal === null || deviceId === null) {
        throw new RPCError("spawn_agent requires a registered device and a goal");
      }
      // The user starting an agent from their own Mac IS the approval
      // (DESIGN.md §2), so the grant for this device is pre-approved.
      const record = this.store.createAgent("Goal agent", goal, [deviceId]);
      const response: { [k: string]: JSONValue } = {
        token: record.token,
        agent_id: record.agentId,
        // The requesting device pins this key itself — the broker is not
        // trusted to push pins.
        public_key: record.publicKeyBase64,
        socket: this.agentEndpoint,
      };
      if (this.mcpShimPath) response.mcp_command = this.mcpShimPath;
      return response;
    });
    rpc.onClose = () => {
      if (registeredId !== null) this.deviceLinks.delete(registeredId);
      this.deviceRPCs.delete(rpc);
    };
    // The listener starts the read loop after this handler returns.
  }

  // MARK: Agent side

  private acceptAgent(conn: Connection): void {
    // First line must be {"type":"domo-auth","token":...}; only then does the
    // connection become an MCP session bound to that agent identity.
    conn.onLine = (line) => {
      let message: JSONValue;
      try {
        message = JSON.parse(line.toString("utf8")) as JSONValue;
      } catch {
        message = null;
      }
      const m = jv(message);
      const token = m.get("token").str;
      const record =
        m.get("type").str === "domo-auth" && token !== null ? this.store.agent(token) : null;
      if (!record) {
        conn.sendLine(canonicalBytes({ type: "domo-auth-error" }));
        conn.close();
        return;
      }
      conn.sendLine(canonicalBytes({ type: "domo-auth-ok" }));
      const session = new MCPSession(this, conn, record.token);
      this.sessions.add(session);
      conn.onClose = () => this.sessions.delete(session);
      conn.onLine = (l) => session.handleLine(l);
    };
  }

  // MARK: Routing helpers used by MCPSession

  deviceLink(deviceId: string): DeviceLink | null {
    return this.deviceLinks.get(deviceId) ?? null;
  }

  onlineDeviceIds(): Set<string> {
    return new Set(this.deviceLinks.keys());
  }

  isDeviceOnline(deviceId: string): boolean {
    return this.deviceLinks.has(deviceId);
  }

  /**
   * Provisioner action (runbook Phase 5): revoke an agent immediately — stop
   * routing, notify every device to reject its intents, drop live sessions.
   */
  revokeAgent(agentId: string): void {
    this.store.revokeAgent(agentId);
    for (const link of this.deviceLinks.values()) {
      void link.rpc.call("revoke_agent", { agent: agentId }).catch(() => {});
    }
    for (const session of [...this.sessions]) {
      if (session.boundAgentId === agentId) session.closeSession();
    }
  }
}
