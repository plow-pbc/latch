import Foundation
import DomoProtocol
import DomoTransport

/// The device-side engine: registers with the broker, receives access requests
/// and intents, runs them through policy, executes approved operations, and
/// audits everything. Shared by the headless runner and the AppKit app.
public final class DeviceAgent {
    public let home: URL
    public let identity: DeviceIdentity
    public let audit: AuditLog
    public let policy: PolicyEngine
    public let blessedTools: BlessedToolRegistry
    public let executor: Executor
    private let knownAgents: KnownAgents
    private weak var delegate: PolicyDelegate?
    private var rpc: LineRPC?
    private let nonceLock = NSLock()
    private var seenNonces = Set<String>()

    // Reconnect state (networked transport only). The Unix-socket loop never had
    // to reconnect; the network will drop, so the Mac re-dials with backoff and
    // re-runs registration each time (runbook Phase 1 / Phase 6).
    private var dialer: ConnectionDialer?
    private var shouldReconnect = false
    private var authenticate = false
    private var backoff: TimeInterval = 0.5
    private let reconnectQueue = DispatchQueue(label: "domo.device.reconnect")

    public var onConnectionClosed: (() -> Void)?
    /// Invoked after each successful (re)connection + registration. Lets the app
    /// reflect link state; not used by the headless runner.
    public var onConnected: (() -> Void)?

    public init(home: URL, name: String, delegate: PolicyDelegate,
                blessedTools: BlessedToolRegistry = .standard(),
                keyStore: DeviceKeyStore? = nil) throws {
        self.home = home
        if let keyStore {
            self.identity = try DeviceIdentity.loadOrCreate(home: home, defaultName: name, keyStore: keyStore)
        } else {
            self.identity = try DeviceIdentity.loadOrCreate(home: home, defaultName: name)
        }
        self.audit = AuditLog(url: home.appendingPathComponent("device/audit.ndjson"))
        self.policy = PolicyEngine(rulesURL: home.appendingPathComponent("device/rules.json"))
        self.knownAgents = KnownAgents(url: home.appendingPathComponent("device/known_agents.json"))
        self.executor = Executor(scratchRoot: home.appendingPathComponent("device/scratch"))
        self.blessedTools = blessedTools
        self.delegate = delegate
    }

    /// v1 convenience: connect over a local Unix domain socket (no reconnect —
    /// a local broker that dies is a hard failure the runner surfaces).
    public func connect(brokerSocket: String) throws {
        try connect(dialer: UnixSocketDialer(path: brokerSocket))
    }

    /// Connect over any transport. Set `reconnect` for the networked path so a
    /// dropped link is re-dialed with exponential backoff and re-registered —
    /// nothing above `LineRPC` changes (runbook Phase 1). Reconnect re-runs
    /// registration/auth; it never assumes retained broker state.
    public func connect(dialer: ConnectionDialer, reconnect: Bool = false,
                        authenticate: Bool = false) throws {
        self.dialer = dialer
        self.shouldReconnect = reconnect
        self.authenticate = authenticate
        try establish()
    }

    private func establish() throws {
        let conn = try dialer!.connect()
        // Networked/hosted broker: prove our identity via the connect challenge
        // BEFORE any RPC (runbook Phase 3). performChallenge starts the read loop
        // itself, so we must not start it again below.
        var alreadyReading = false
        if authenticate {
            try performChallenge(on: conn)
            alreadyReading = true
        }
        let rpc = LineRPC(connection: conn)
        self.rpc = rpc
        rpc.register("access_request") { [weak self] params, reply in
            self?.handleAccessRequest(params, reply: reply)
        }
        rpc.register("intent") { [weak self] params, reply in
            self?.handleIntent(params, reply: reply)
        }
        rpc.register("get_output") { [weak self] params, reply in
            self?.handleGetOutput(params, reply: reply)
        }
        rpc.register("revoke_agent") { [weak self] params, reply in
            guard let self, let agentId = params["agent"].str else {
                reply(.failure(RPCError("revoke_agent requires an agent id"))); return
            }
            self.revokeAgent(agentId: agentId)
            reply(.success(["ok": true]))
        }
        rpc.onClose = { [weak self] in self?.handleDisconnect() }
        if !alreadyReading { rpc.start() }
        _ = try rpc.call("register", [
            "device": [
                "id": .string(identity.deviceId),
                "name": .string(identity.name),
                "publicKey": .string(identity.keyPair.publicKeyBase64),
            ],
            "blessedTools": blessedTools.manifest(),
        ])
        backoff = 0.5
        audit.record("device_started", ["device": .string(identity.deviceId)])
        onConnected?()
    }

    /// Answer the broker's connect challenge on the raw connection before LineRPC
    /// takes over. Starts the read loop (the caller must not start it again).
    /// Throws if the broker rejects us (unenrolled key / bad signature) or times
    /// out — the link is dropped and reconnect will retry.
    private func performChallenge(on conn: Connection) throws {
        let semaphore = DispatchSemaphore(value: 0)
        var outcome: Result<Void, Error> = .failure(RPCError("challenge timed out"))
        conn.onLine = { [weak self] line in
            guard let self else { return }
            guard let msg = try? JSONValue.parse(line), let type = msg["type"].str else { return }
            switch type {
            case "challenge":
                guard let nonce = msg["nonce"].str else { return }
                do {
                    let signature = try DeviceChallenge.sign(nonce: nonce, keyPair: self.identity.keyPair)
                    conn.sendLine(JSONValue.object([
                        "type": "challenge-response",
                        "deviceId": .string(self.identity.deviceId),
                        "publicKey": .string(self.identity.keyPair.publicKeyBase64),
                        "signature": .string(signature),
                    ]).encoded())
                } catch {
                    outcome = .failure(error); semaphore.signal()
                }
            case "auth-ok":
                outcome = .success(()); semaphore.signal()
            case "auth-error":
                outcome = .failure(RPCError("enrollment challenge rejected: \(msg["reason"].str ?? "")"))
                semaphore.signal()
            default:
                break
            }
        }
        conn.startReading()
        if semaphore.wait(timeout: .now() + 15) != .success {
            conn.close()
            throw RPCError("challenge timed out")
        }
        try outcome.get()
    }

    private func handleDisconnect() {
        guard shouldReconnect else { onConnectionClosed?(); return }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        let delay = backoff
        backoff = min(backoff * 2, 30)
        reconnectQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.shouldReconnect else { return }
            do {
                try self.establish()
            } catch {
                self.scheduleReconnect()
            }
        }
    }

    /// Stop reconnecting and drop the current link. Call before discarding a
    /// DeviceAgent that was connected with `reconnect: true`.
    public func disconnect() {
        shouldReconnect = false
        rpc?.close()
    }

    /// Ask the broker to mint a pre-approved agent for a goal (the Mac-initiated
    /// spin-up flow). The user launching this from their own Mac *is* the
    /// approval, so we pin the new agent's key immediately — otherwise its
    /// signed intents would be rejected as coming from an unknown agent.
    /// Returns {token, agent_id, socket, mcp_command} for the MCP config.
    public func requestSpawnAgent(goal: String, timeout: TimeInterval = 15) throws -> JSONValue {
        guard let rpc else { throw RPCError("not connected") }
        let response = try rpc.call("spawn_agent", ["goal": .string(goal)], timeout: timeout)
        if let agentId = response["agent_id"].str, let publicKey = response["public_key"].str {
            knownAgents.pin(agentId: agentId, publicKey: publicKey)
            audit.record("agent_spawned", ["agent": .string(agentId), "goal": .string(goal)])
        }
        return response
    }

    // MARK: - Handlers

    private func handleAccessRequest(_ params: JSONValue,
                                     reply: @escaping (Result<JSONValue, RPCError>) -> Void) {
        let agentId = params["agent"]["id"].str ?? "?"
        let display = params["agent"]["display"].str ?? agentId
        let publicKey = params["agent"]["publicKey"].str ?? ""
        let goals = params["goals"].str ?? ""
        audit.record("access_request", ["agent": .string(agentId), "display": .string(display),
                                        "goals": .string(goals)])
        guard let delegate else {
            reply(.failure(RPCError("no policy delegate")))
            return
        }
        delegate.decideAccess(agentId: agentId, agentDisplay: display, goals: goals) { [weak self] approved in
            guard let self else { return }
            if approved {
                self.knownAgents.pin(agentId: agentId, publicKey: publicKey)
            }
            self.audit.record("access_decision", ["agent": .string(agentId),
                                                  "approved": .bool(approved)])
            reply(.success(["approved": .bool(approved)]))
        }
    }

    private func handleIntent(_ params: JSONValue,
                              reply: @escaping (Result<JSONValue, RPCError>) -> Void) {
        let intent: Intent
        do {
            intent = try params["intent"].decode(Intent.self)
        } catch {
            reply(.failure(RPCError("malformed intent: \(error)")))
            return
        }
        let payload = params["payload"]

        if let failure = validate(intent) {
            audit.record("intent_rejected", ["intentId": .string(intent.intentId),
                                             "reason": .string(failure)])
            reply(.success(["status": "rejected", "reason": .string(failure)]))
            return
        }

        audit.record("intent_received", [
            "intentId": .string(intent.intentId),
            "agent": .string(intent.agentId),
            "request": .string(intent.request),
            "goal": .string(intent.goal ?? ""),
            "capabilities": .array(intent.capabilities.map { .string($0.display) }),
        ])

        guard let delegate else {
            reply(.failure(RPCError("no policy delegate")))
            return
        }
        policy.decide(intent, delegate: delegate) { [weak self] grant in
            guard let self else { return }
            self.audit.record("intent_decision", [
                "intentId": .string(intent.intentId),
                "decision": .string(grant.decision.rawValue),
                "source": .string(grant.source),
            ])
            guard grant.decision.isAllowed else {
                reply(.success(["status": "denied"]))
                return
            }
            let result = self.execute(intent, payload: payload)
            reply(.success(result))
        }
    }

    /// Revoke an agent locally and authoritatively (runbook Phase 5). The device
    /// then refuses that agent's intents even if a stale broker keeps routing
    /// them. Safe to call mid-session.
    public func revokeAgent(agentId: String) {
        knownAgents.revoke(agentId: agentId)
        audit.record("agent_revoked", ["agent": .string(agentId)])
    }

    private func validate(_ intent: Intent) -> String? {
        if intent.deviceId != identity.deviceId { return "wrong device" }
        if intent.isExpired { return "expired" }
        if knownAgents.isRevoked(intent.agentId) { return "revoked agent" }
        nonceLock.lock()
        let replayed = !seenNonces.insert(intent.nonce).inserted
        nonceLock.unlock()
        if replayed { return "replayed nonce" }
        guard let pinned = knownAgents.publicKey(for: intent.agentId) else {
            return "unknown agent (no access grant)"
        }
        if pinned != intent.agentPublicKey { return "public key mismatch" }
        if !intent.verifySignature() { return "bad signature" }
        return nil
    }

    // MARK: - Execution

    private func execute(_ intent: Intent, payload: JSONValue) -> JSONValue {
        if let exec = intent.capabilities.first(where: { $0.kind == .processExec }) {
            return executeCommand(intent, exec: exec, payload: payload)
        }
        if let toolCap = intent.capabilities.first(where: { $0.kind == .tool }) {
            return executeTool(intent, toolCap: toolCap, payload: payload)
        }
        if let write = intent.capabilities.first(where: { $0.kind == .fsWrite }) {
            return executeWrite(intent, cap: write, payload: payload)
        }
        if let read = intent.capabilities.first(where: { $0.kind == .fsRead }) {
            return executeRead(intent, cap: read)
        }
        return ["status": "error", "error": "no executable capability in intent"]
    }

    private func executeRead(_ intent: Intent, cap: Capability) -> JSONValue {
        guard let path = cap.paths?.first else {
            return ["status": "error", "error": "missing path"]
        }
        do {
            let data = try FileOps.read(path: path, allowedRoots: cap.paths ?? [])
            audit.record("file_read", ["intentId": .string(intent.intentId),
                                       "path": .string(path),
                                       "bytes": .number(Double(data.count))])
            return ["status": "completed", "content_base64": .string(data.base64EncodedString()),
                    "bytes": .number(Double(data.count))]
        } catch {
            audit.record("denied_operation", ["intentId": .string(intent.intentId),
                                              "path": .string(path),
                                              "error": .string("\(error)")])
            return ["status": "error", "error": .string("\(error)")]
        }
    }

    private func executeWrite(_ intent: Intent, cap: Capability, payload: JSONValue) -> JSONValue {
        guard let path = cap.paths?.first else {
            return ["status": "error", "error": "missing path"]
        }
        guard let contentBase64 = payload["content_base64"].str,
              let data = Data(base64Encoded: contentBase64) else {
            return ["status": "error", "error": "missing content"]
        }
        do {
            try FileOps.write(path: path, data: data, allowedRoots: cap.paths ?? [])
            audit.record("file_write", ["intentId": .string(intent.intentId),
                                        "path": .string(path),
                                        "bytes": .number(Double(data.count))])
            return ["status": "completed", "bytes": .number(Double(data.count))]
        } catch {
            audit.record("denied_operation", ["intentId": .string(intent.intentId),
                                              "path": .string(path),
                                              "error": .string("\(error)")])
            return ["status": "error", "error": .string("\(error)")]
        }
    }

    private func executeCommand(_ intent: Intent, exec: Capability, payload: JSONValue) -> JSONValue {
        let readPaths = intent.capabilities.first(where: { $0.kind == .fsRead })?.paths ?? []
        let writePaths = intent.capabilities.first(where: { $0.kind == .fsWrite })?.paths ?? []
        let network = intent.capabilities.first(where: { $0.kind == .network })?.allowed ?? false
        // wait_ms is delivery detail, not an approved capability, so it rides
        // in the payload rather than the signed intent.
        let waitMs = payload["wait_ms"].int ?? 10000
        audit.record("exec_start", ["intentId": .string(intent.intentId),
                                    "argv": .array((exec.argv ?? []).map { .string($0) })])
        do {
            let result = try executor.run(argv: exec.argv ?? [], cwd: exec.cwd,
                                          readPaths: readPaths, writePaths: writePaths,
                                          network: network, waitMs: waitMs)
            if !result.running {
                audit.record("exec_end", ["intentId": .string(intent.intentId),
                                          "exit_code": .number(Double(result.exitCode ?? -1))])
            }
            var response: JSONValue = [
                "status": .string(result.running ? "running" : "completed"),
                "handle": .string(result.handle),
                "output": .string(String(data: result.output, encoding: .utf8) ?? ""),
                "output_length": .number(Double(result.outputLength)),
            ]
            if let exitCode = result.exitCode, case .object(var obj) = response {
                obj["exit_code"] = .number(Double(exitCode))
                response = .object(obj)
            }
            return response
        } catch {
            audit.record("exec_error", ["intentId": .string(intent.intentId),
                                        "error": .string("\(error)")])
            return ["status": "error", "error": .string("\(error)")]
        }
    }

    private func executeTool(_ intent: Intent, toolCap: Capability, payload: JSONValue) -> JSONValue {
        guard let name = toolCap.tool, let tool = blessedTools.tool(named: name) else {
            return ["status": "error", "error": "unknown tool"]
        }
        do {
            let result = try tool.invoke(payload["args"])
            audit.record("tool_invoked", ["intentId": .string(intent.intentId),
                                          "tool": .string(name)])
            return ["status": "completed", "result": result]
        } catch {
            audit.record("tool_error", ["intentId": .string(intent.intentId),
                                        "tool": .string(name), "error": .string("\(error)")])
            return ["status": "error", "error": .string("\(error)")]
        }
    }

    private func handleGetOutput(_ params: JSONValue,
                                 reply: @escaping (Result<JSONValue, RPCError>) -> Void) {
        guard let handle = params["handle"].str else {
            reply(.failure(RPCError("missing handle")))
            return
        }
        let since = params["since"].int ?? 0
        do {
            let result = try executor.output(handle: handle, since: since)
            if !result.running, let exitCode = result.exitCode {
                audit.record("exec_end", ["handle": .string(handle),
                                          "exit_code": .number(Double(exitCode))])
            }
            var response: JSONValue = [
                "status": .string(result.running ? "running" : "completed"),
                "output": .string(String(data: result.output, encoding: .utf8) ?? ""),
                "output_length": .number(Double(result.outputLength)),
            ]
            if let exitCode = result.exitCode, case .object(var obj) = response {
                obj["exit_code"] = .number(Double(exitCode))
                response = .object(obj)
            }
            reply(.success(response))
        } catch {
            reply(.failure(RPCError("\(error)")))
        }
    }
}
