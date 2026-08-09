import Foundation
import DomoProtocol
import DomoTransport

/// The local rendezvous service: device registry + agent identities/grants +
/// message routing + the agent-facing MCP endpoint. The cloud broker of the
/// remote milestone implements this same wire contract (DESIGN.md §1).
public final class Broker {
    public let home: URL
    public let store: BrokerStore
    private let agentListener: ConnectionListener
    private let deviceListener: ConnectionListener
    private let lock = NSLock()
    private var deviceLinks: [String: DeviceLink] = [:]
    private var sessions: [ObjectIdentifier: MCPSession] = [:]
    /// Strong references to per-connection device RPCs, keyed by connection,
    /// so they outlive acceptDevice (the SocketServer retains the connection;
    /// the broker must retain the RPC layered on top of it).
    private var deviceRPCs: [ObjectIdentifier: LineRPC] = [:]
    /// Path to the domo-mcp shim, advertised in spawn_agent responses.
    public var mcpShimPath: String?
    /// The address agents dial to reach this broker — a Unix socket path for the
    /// v1 loop, a `ws(s)://` URL once networked. Advertised in spawn_agent
    /// responses so a spawned agent knows where to connect.
    public let agentEndpoint: String
    /// When true (networked/hosted broker), devices must pass a connect-time
    /// challenge signed by an ENROLLED identity key before any RPC (runbook
    /// Phase 3). The v1 local loop leaves this off — filesystem perms on the
    /// 0700 run dir are the trust boundary there — so existing tests are
    /// unchanged.
    public let requireEnrollment: Bool

    struct DeviceLink {
        let rpc: LineRPC
        var record: DeviceRecord
        var blessedTools: JSONValue
    }

    /// Designated init: the transport is injected as two `ConnectionListener`s,
    /// so the broker is identical whether it runs over Unix sockets (v1) or
    /// WebSocket (networked milestone). `agentEndpoint` is the address agents
    /// dial, advertised in spawn_agent responses.
    public init(home: URL, agentListener: ConnectionListener,
                deviceListener: ConnectionListener, agentEndpoint: String,
                requireEnrollment: Bool = false) throws {
        self.home = home
        self.agentEndpoint = agentEndpoint
        self.requireEnrollment = requireEnrollment
        store = BrokerStore(home: home)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        self.agentListener = agentListener
        self.deviceListener = deviceListener
        agentListener.onConnection = { [weak self] conn in self?.acceptAgent(conn) }
        deviceListener.onConnection = { [weak self] conn in self?.acceptDevice(conn) }
    }

    /// v1 convenience: build the broker over local Unix domain sockets.
    public convenience init(home: URL, agentSocket: String, deviceSocket: String) throws {
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let agentListener = try SocketServer(path: agentSocket)
        let deviceListener = try SocketServer(path: deviceSocket)
        try self.init(home: home, agentListener: agentListener,
                      deviceListener: deviceListener, agentEndpoint: agentSocket)
    }

    public func start() {
        agentListener.start()
        deviceListener.start()
    }

    public func stop() {
        agentListener.stop()
        deviceListener.stop()
    }

    // MARK: - Device side

    private func acceptDevice(_ conn: Connection) {
        guard requireEnrollment else { setupDeviceRPC(conn); return }
        // Networked broker: authenticate the device BEFORE any RPC. Send a fresh
        // nonce; accept only a response signed by an enrolled identity key.
        let nonce = DeviceChallenge.newNonce()
        conn.onLine = { [weak self, weak conn] line in
            guard let self, let conn else { return }
            func reject(_ reason: String) {
                conn.sendLine(JSONValue.object(["type": "auth-error", "reason": .string(reason)]).encoded())
                conn.close()
            }
            guard let msg = try? JSONValue.parse(line),
                  msg["type"].str == "challenge-response",
                  let deviceId = msg["deviceId"].str,
                  let publicKey = msg["publicKey"].str,
                  let signature = msg["signature"].str else {
                reject("malformed challenge-response"); return
            }
            guard let enrolled = self.store.deviceById(deviceId),
                  enrolled.publicKeyBase64 == publicKey else {
                reject("device not enrolled"); return
            }
            guard DeviceChallenge.verify(nonce: nonce, signatureBase64: signature,
                                         publicKeyBase64: publicKey) else {
                reject("bad challenge signature"); return
            }
            conn.sendLine(JSONValue.object(["type": "auth-ok"]).encoded())
            // Identity proven — hand the connection off to the normal RPC path.
            self.setupDeviceRPC(conn)
        }
        conn.sendLine(JSONValue.object(["type": "challenge", "nonce": .string(nonce)]).encoded())
    }

    private func setupDeviceRPC(_ conn: Connection) {
        let rpc = LineRPC(connection: conn)
        lock.lock()
        deviceRPCs[ObjectIdentifier(conn)] = rpc
        lock.unlock()
        var registeredId: String?
        rpc.register("register") { [weak self, weak rpc] params, reply in
            guard let self, let rpc else { return }
            guard let id = params["device"]["id"].str,
                  let name = params["device"]["name"].str,
                  let publicKey = params["device"]["publicKey"].str else {
                reply(.failure(RPCError("malformed register")))
                return
            }
            let record = DeviceRecord(deviceId: id, name: name, publicKeyBase64: publicKey)
            self.store.upsertDevice(record)
            self.lock.lock()
            self.deviceLinks[id] = DeviceLink(rpc: rpc, record: record,
                                              blessedTools: params["blessedTools"])
            self.lock.unlock()
            registeredId = id
            reply(.success(["ok": true]))
        }
        rpc.register("spawn_agent") { [weak self] params, reply in
            guard let self else { return }
            guard let goal = params["goal"].str, let deviceId = registeredId else {
                reply(.failure(RPCError("spawn_agent requires a registered device and a goal")))
                return
            }
            // The user starting an agent from their own Mac *is* the approval,
            // so the grant for this device is pre-approved (DESIGN.md §2).
            let record = self.store.createAgent(display: "Goal agent",
                                                sessionGoals: goal,
                                                grantedDevices: [deviceId])
            var response: [String: JSONValue] = [
                "token": .string(record.token),
                "agent_id": .string(record.agentId),
                // The requesting device pins this key itself (it initiated the
                // spawn, so it is the approver) — the broker is not trusted to
                // push pins.
                "public_key": .string(record.publicKeyBase64),
                "socket": .string(self.agentEndpoint),
            ]
            if let shim = self.mcpShimPath { response["mcp_command"] = .string(shim) }
            reply(.success(.object(response)))
        }
        // rpc-level hook so LineRPC still fails its pending calls on close.
        rpc.onClose = { [weak self, weak conn] in
            guard let self else { return }
            self.lock.lock()
            if let id = registeredId { self.deviceLinks.removeValue(forKey: id) }
            if let conn { self.deviceRPCs.removeValue(forKey: ObjectIdentifier(conn)) }
            self.lock.unlock()
        }
        // The SocketServer starts the read loop after this handler returns, so
        // do not call rpc.start() here (it would double-read the socket).
    }

    // MARK: - Agent side

    private func acceptAgent(_ conn: Connection) {
        // First line must be {"type":"domo-auth","token":...}; only then does
        // the connection become an MCP session bound to that agent identity.
        conn.onLine = { [weak self, weak conn] line in
            guard let self, let conn else { return }
            guard let message = try? JSONValue.parse(line),
                  message["type"].str == "domo-auth",
                  let token = message["token"].str,
                  let record = self.store.agent(token: token) else {
                conn.sendLine(JSONValue.object(["type": "domo-auth-error"]).encoded())
                conn.close()
                return
            }
            conn.sendLine(JSONValue.object(["type": "domo-auth-ok"]).encoded())
            let session = MCPSession(broker: self, connection: conn, agentToken: record.token)
            self.lock.lock()
            self.sessions[ObjectIdentifier(session)] = session
            self.lock.unlock()
            conn.onClose = { [weak self, weak session] in
                guard let self, let session else { return }
                self.lock.lock()
                self.sessions.removeValue(forKey: ObjectIdentifier(session))
                self.lock.unlock()
            }
            conn.onLine = { [weak session] line in session?.handleLine(line) }
        }
    }

    // MARK: - Routing helpers used by MCPSession

    func deviceLink(_ deviceId: String) -> DeviceLink? {
        lock.lock()
        defer { lock.unlock() }
        return deviceLinks[deviceId]
    }

    func onlineDeviceIds() -> Set<String> {
        lock.lock()
        defer { lock.unlock() }
        return Set(deviceLinks.keys)
    }

    /// Public health/observability accessor: is a device currently linked?
    /// Used by hosting/monitoring and by tests to observe (re)connection.
    public func isDeviceOnline(_ deviceId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return deviceLinks[deviceId] != nil
    }

    /// Provisioner action (runbook Phase 5): revoke an agent. Takes effect
    /// immediately — the broker stops routing for it, notifies every device to
    /// reject its intents (even in-flight), and drops its live sessions.
    public func revokeAgent(_ agentId: String) {
        store.revokeAgent(agentId: agentId)
        lock.lock()
        let links = Array(deviceLinks.values)
        let liveSessions = Array(sessions.values)
        lock.unlock()
        for link in links {
            link.rpc.callAsync("revoke_agent", ["agent": .string(agentId)]) { _ in }
        }
        for session in liveSessions where session.boundAgentId == agentId {
            session.closeSession()
        }
    }
}
