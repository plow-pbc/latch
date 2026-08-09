import Foundation
import XCTest
import DomoProtocol
import DomoTransport
import DomoBrokerCore
import DomoDeviceCore

/// An in-process stack wired over the WebSocket transport (loopback), so the
/// networked path is exercised deterministically without spawning processes.
/// The Unix-socket E2E suite remains the default; this proves the SAME broker +
/// device + MCP business logic runs unchanged over the network (runbook Phase 1).
final class NetworkStack {
    let home: URL
    let broker: Broker
    let device: DeviceAgent
    let policy: HeadlessPolicy
    let agentPort: UInt16
    let devicePort: UInt16
    private let agentListener: WebSocketListener
    private let deviceListener: WebSocketListener

    var deviceId: String { device.identity.deviceId }

    /// - Parameters:
    ///   - serverIdentity: server cert for `wss://` (Phase 2); nil = plain `ws://`.
    ///   - agentTrust/deviceTrust: pin evaluators the dialers use (Phase 2).
    init(policyConfig: HeadlessPolicy.Config = .init(access: "allow", intent: "allow_once"),
         serverIdentity: SecIdentity? = nil,
         deviceTrust: PeerTrustEvaluator? = nil,
         requireEnrollment: Bool = false) throws {
        home = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("domo-net-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)

        agentListener = try WebSocketListener(port: 0, identity: serverIdentity)
        deviceListener = try WebSocketListener(port: 0, identity: serverIdentity)

        agentListener.start()
        deviceListener.start()
        guard let aPort = agentListener.waitForPort(), let dPort = deviceListener.waitForPort() else {
            throw NSError(domain: "NetworkStack", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "listeners did not bind"])
        }
        agentPort = aPort
        devicePort = dPort

        let scheme = serverIdentity == nil ? "ws" : "wss"
        broker = try Broker(home: home, agentListener: agentListener,
                            deviceListener: deviceListener,
                            agentEndpoint: "\(scheme)://127.0.0.1:\(aPort)/",
                            requireEnrollment: requireEnrollment)

        policy = HeadlessPolicy(config: policyConfig)
        device = try DeviceAgent(home: home.appendingPathComponent("devhome"),
                                 name: "NetMac", delegate: policy)
        if requireEnrollment {
            // Stand in for the provisioner: authorize this device's identity key.
            broker.store.enrollDevice(deviceId: device.identity.deviceId, name: "NetMac",
                                      publicKeyBase64: device.identity.keyPair.publicKeyBase64)
        }
        let dialer = WebSocketDialer(url: URL(string: "\(scheme)://127.0.0.1:\(dPort)/")!,
                                     trust: deviceTrust)
        try device.connect(dialer: dialer, authenticate: requireEnrollment)
        waitUntilOnline()
    }

    /// Mint an agent record directly in the broker store (stands in for
    /// provisioning). Returns its token + id.
    func createAgent(name: String, grantedDevices: [String] = []) -> (token: String, agentId: String) {
        let record = broker.store.createAgent(display: name, grantedDevices: grantedDevices)
        return (record.token, record.agentId)
    }

    func agentDialer(scheme: String? = nil, trust: PeerTrustEvaluator? = nil) -> WebSocketDialer {
        let s = scheme ?? (broker.agentEndpoint.hasPrefix("wss") ? "wss" : "ws")
        return WebSocketDialer(url: URL(string: "\(s)://127.0.0.1:\(agentPort)/")!, trust: trust)
    }

    var deviceAuditURL: URL {
        home.appendingPathComponent("devhome/device/audit.ndjson")
    }

    func auditEvents() -> [String] {
        rawAuditEvents().compactMap { $0["event"].str }
    }

    func rawAuditEvents() -> [JSONValue] {
        guard let data = try? Data(contentsOf: deviceAuditURL) else { return [] }
        return data.split(separator: 0x0A).compactMap { try? JSONValue.parse(Data($0)) }
    }

    private func waitUntilOnline() {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if broker.isDeviceOnline(deviceId) { return }
            Thread.sleep(forTimeInterval: 0.02)
        }
    }

    func shutdown() {
        device.disconnect()
        broker.stop()
        try? FileManager.default.removeItem(at: home)
    }
}

/// A minimal MCP client speaking JSON-RPC over any `Connection` — the same wire
/// the domo-mcp shim + Claude Code use, but transport-agnostic so it runs over
/// WebSocket here.
final class NetworkMCPClient {
    private let conn: Connection
    private let lock = NSLock()
    private var pending: [Int: (JSONValue) -> Void] = [:]
    private var nextId = 1
    private let authSemaphore = DispatchSemaphore(value: 0)
    private(set) var authOk = false
    private(set) var authRejected = false
    private let closedLock = NSLock()
    private var _closed = false
    var isClosed: Bool { closedLock.lock(); defer { closedLock.unlock() }; return _closed }

    init(dialer: ConnectionDialer, token: String) throws {
        conn = try dialer.connect()
        conn.onLine = { [weak self] line in self?.handleLine(line) }
        conn.onClose = { [weak self] in
            guard let self else { return }
            self.closedLock.lock(); self._closed = true; self.closedLock.unlock()
        }
        conn.startReading()
        conn.sendLine(JSONValue.object(["type": "domo-auth", "token": .string(token)]).encoded())
        _ = authSemaphore.wait(timeout: .now() + 5)
    }

    private func handleLine(_ line: Data) {
        guard let message = try? JSONValue.parse(line) else { return }
        if let type = message["type"].str {
            if type == "domo-auth-ok" { authOk = true }
            if type == "domo-auth-error" { authRejected = true }
            authSemaphore.signal()
            return
        }
        guard let id = message["id"].int else { return }
        lock.lock()
        let completion = pending.removeValue(forKey: id)
        lock.unlock()
        completion?(message)
    }

    func request(_ method: String, _ params: JSONValue = [:],
                 timeout: TimeInterval = 30) throws -> JSONValue {
        lock.lock()
        let id = nextId
        nextId += 1
        let semaphore = DispatchSemaphore(value: 0)
        var response: JSONValue = .null
        pending[id] = { message in response = message; semaphore.signal() }
        lock.unlock()
        conn.sendLine(JSONValue.object([
            "jsonrpc": "2.0", "id": .number(Double(id)),
            "method": .string(method), "params": params,
        ]).encoded())
        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            throw NSError(domain: "NetworkMCPClient", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "timeout on \(method)"])
        }
        return response
    }

    func initializeSession() throws {
        _ = try request("initialize", [
            "protocolVersion": "2024-11-05", "capabilities": [:],
            "clientInfo": ["name": "net-e2e", "version": "0"],
        ])
    }

    func callTool(_ name: String, _ args: JSONValue = [:],
                  timeout: TimeInterval = 60) throws -> (JSONValue, Bool) {
        let response = try request("tools/call",
                                   ["name": .string(name), "arguments": args], timeout: timeout)
        let result = response["result"]
        let isError = result["isError"].boolValue ?? false
        let text = result["content"][0]["text"].str ?? ""
        let parsed = (try? JSONValue.parse(text)) ?? .string(text)
        return (parsed, isError)
    }

    func close() { conn.close() }
}
