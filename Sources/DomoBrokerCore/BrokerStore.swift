import Foundation
import DomoProtocol

/// One provisioned agent identity. v1 keeps the private key broker-side —
/// the agent *runtime* holds the key, since the LLM itself can't do crypto
/// (DESIGN.md §4). Tokens authenticate the MCP connection.
public struct AgentRecord: Codable {
    public var token: String
    public var agentId: String
    public var display: String
    public var privateKeyBase64: String
    public var publicKeyBase64: String
    public var grantedDevices: [String]
    public var sessionGoals: String?

    public func keyPair() throws -> KeyPair {
        guard let data = Data(base64Encoded: privateKeyBase64) else {
            throw RPCErrorShim("corrupt agent key")
        }
        return try KeyPair(rawRepresentation: data)
    }
}

public struct DeviceRecord: Codable {
    public var deviceId: String
    public var name: String
    public var publicKeyBase64: String
}

struct RPCErrorShim: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

/// Broker persistence: agents.json + devices.json under DOMO_HOME/broker.
public final class BrokerStore {
    private let home: URL
    private let lock = NSLock()
    private var agents: [String: AgentRecord] // token -> record
    private var devices: [String: DeviceRecord] // deviceId -> record
    private var revoked: Set<String> // revoked agentIds

    private var agentsURL: URL { home.appendingPathComponent("broker/agents.json") }
    private var devicesURL: URL { home.appendingPathComponent("broker/devices.json") }
    private var revokedURL: URL { home.appendingPathComponent("broker/revoked.json") }

    public init(home: URL) {
        self.home = home
        agents = [:]
        devices = [:]
        revoked = []
        if let data = try? Data(contentsOf: agentsURL),
           let stored = try? JSONDecoder().decode([AgentRecord].self, from: data) {
            agents = Dictionary(uniqueKeysWithValues: stored.map { ($0.token, $0) })
        }
        if let data = try? Data(contentsOf: devicesURL),
           let stored = try? JSONDecoder().decode([DeviceRecord].self, from: data) {
            devices = Dictionary(uniqueKeysWithValues: stored.map { ($0.deviceId, $0) })
        }
        if let data = try? Data(contentsOf: revokedURL),
           let stored = try? JSONDecoder().decode([String].self, from: data) {
            revoked = Set(stored)
        }
    }

    /// Provisioner action (runbook Phase 5): revoke an agent. The broker then
    /// refuses to route for it; the device is notified so it rejects even a stale
    /// broker's routing. Reloads from disk so a separate provisioner process's
    /// revocation is honored without a broker restart.
    public func revokeAgent(agentId: String) {
        lock.lock()
        revoked.insert(agentId)
        let snapshot = Array(revoked)
        lock.unlock()
        try? FileManager.default.createDirectory(at: home.appendingPathComponent("broker"),
                                                 withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? encoder.encode(snapshot).write(to: revokedURL)
    }

    public func isRevoked(agentId: String) -> Bool {
        lock.lock()
        if revoked.contains(agentId) { lock.unlock(); return true }
        lock.unlock()
        if let data = try? Data(contentsOf: revokedURL),
           let stored = try? JSONDecoder().decode([String].self, from: data) {
            lock.lock()
            revoked.formUnion(stored)
            let hit = revoked.contains(agentId)
            lock.unlock()
            return hit
        }
        return false
    }

    public func agent(token: String) -> AgentRecord? {
        lock.lock()
        defer { lock.unlock() }
        if let record = agents[token] { return record }
        // Miss: an agent may have been added by a separate `create-agent`
        // process after this broker started. Reload from disk and retry, so a
        // running broker sees newly-provisioned agents without a restart.
        mergeAgentsFromDiskLocked()
        return agents[token]
    }

    /// Add any agents present on disk but not in memory. Existing in-memory
    /// records win, since every mutation persists immediately (disk is never
    /// ahead of memory for a token we already hold).
    private func mergeAgentsFromDiskLocked() {
        guard let data = try? Data(contentsOf: agentsURL),
              let stored = try? JSONDecoder().decode([AgentRecord].self, from: data) else { return }
        for record in stored where agents[record.token] == nil {
            agents[record.token] = record
        }
    }

    public func createAgent(display: String, sessionGoals: String? = nil,
                            grantedDevices: [String] = []) -> AgentRecord {
        let keyPair = KeyPair()
        let record = AgentRecord(token: UUID().uuidString,
                                 agentId: keyPair.fingerprint,
                                 display: display,
                                 privateKeyBase64: keyPair.privateKeyBase64,
                                 publicKeyBase64: keyPair.publicKeyBase64,
                                 grantedDevices: grantedDevices,
                                 sessionGoals: sessionGoals)
        lock.lock()
        agents[record.token] = record
        lock.unlock()
        persist()
        return record
    }

    public func grantDevice(token: String, deviceId: String) {
        lock.lock()
        if var record = agents[token], !record.grantedDevices.contains(deviceId) {
            record.grantedDevices.append(deviceId)
            agents[token] = record
        }
        lock.unlock()
        persist()
    }

    public func recordSessionGoals(token: String, goals: String) {
        lock.lock()
        if var record = agents[token] {
            record.sessionGoals = goals
            agents[token] = record
        }
        lock.unlock()
        persist()
    }

    public func upsertDevice(_ device: DeviceRecord) {
        lock.lock()
        devices[device.deviceId] = device
        lock.unlock()
        persist()
    }

    /// Provisioner action: authorize a device's identity key for this broker
    /// (runbook Phase 3 enrollment). The production front-end is the signed-in
    /// web session entering the Mac's pairing code (DESIGN.md §2); it lands here.
    /// A device whose key is not enrolled cannot pass the connect challenge.
    @discardableResult
    public func enrollDevice(deviceId: String, name: String, publicKeyBase64: String) -> DeviceRecord {
        let record = DeviceRecord(deviceId: deviceId, name: name, publicKeyBase64: publicKeyBase64)
        upsertDevice(record)
        return record
    }

    /// The enrolled record for a device id, reloading from disk on a miss so a
    /// device enrolled by a separate provisioner process is visible without a
    /// broker restart (mirrors the agent reload-on-miss).
    public func deviceById(_ deviceId: String) -> DeviceRecord? {
        lock.lock()
        defer { lock.unlock() }
        if let record = devices[deviceId] { return record }
        if let data = try? Data(contentsOf: devicesURL),
           let stored = try? JSONDecoder().decode([DeviceRecord].self, from: data) {
            for record in stored where devices[record.deviceId] == nil {
                devices[record.deviceId] = record
            }
        }
        return devices[deviceId]
    }

    public func allDevices() -> [DeviceRecord] {
        lock.lock()
        defer { lock.unlock() }
        return Array(devices.values).sorted { $0.name < $1.name }
    }

    private func persist() {
        lock.lock()
        // Merge first so we never clobber an agent a separate create-agent
        // process wrote to disk while we were running.
        mergeAgentsFromDiskLocked()
        let agentSnapshot = Array(agents.values)
        let deviceSnapshot = Array(devices.values)
        lock.unlock()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? FileManager.default.createDirectory(at: home.appendingPathComponent("broker"),
                                                 withIntermediateDirectories: true)
        try? encoder.encode(agentSnapshot).write(to: agentsURL)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: agentsURL.path)
        try? encoder.encode(deviceSnapshot).write(to: devicesURL)
    }
}
