import Foundation
import DomoProtocol
import DomoTransport

/// The local rendezvous service: device registry + agent identities/grants +
/// message routing + the agent-facing MCP endpoint. The cloud broker of the
/// remote milestone implements this same wire contract (DESIGN.md §1).
public final class Broker {
    public let home: URL
    public let store: BrokerStore
    private let agentServer: SocketServer
    private let deviceServer: SocketServer
    private let lock = NSLock()
    private var deviceLinks: [String: DeviceLink] = [:]
    private var sessions: [ObjectIdentifier: MCPSession] = [:]
    /// Strong references to per-connection device RPCs, keyed by connection,
    /// so they outlive acceptDevice (the SocketServer retains the connection;
    /// the broker must retain the RPC layered on top of it).
    private var deviceRPCs: [ObjectIdentifier: LineRPC] = [:]
    /// Path to the domo-mcp shim, advertised in spawn_agent responses.
    public var mcpShimPath: String?
    public let agentSocketPath: String

    struct DeviceLink {
        let rpc: LineRPC
        var record: DeviceRecord
        var blessedTools: JSONValue
    }

    public init(home: URL, agentSocket: String, deviceSocket: String) throws {
        self.home = home
        self.agentSocketPath = agentSocket
        store = BrokerStore(home: home)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        agentServer = try SocketServer(path: agentSocket)
        deviceServer = try SocketServer(path: deviceSocket)
        agentServer.onConnection = { [weak self] conn in self?.acceptAgent(conn) }
        deviceServer.onConnection = { [weak self] conn in self?.acceptDevice(conn) }
    }

    public func start() {
        agentServer.start()
        deviceServer.start()
    }

    public func stop() {
        agentServer.stop()
        deviceServer.stop()
    }

    // MARK: - Device side

    private func acceptDevice(_ conn: Connection) {
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
                "socket": .string(self.agentSocketPath),
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
}
