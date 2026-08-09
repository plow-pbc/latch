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

    private var agentsURL: URL { home.appendingPathComponent("broker/agents.json") }
    private var devicesURL: URL { home.appendingPathComponent("broker/devices.json") }

    public init(home: URL) {
        self.home = home
        agents = [:]
        devices = [:]
        if let data = try? Data(contentsOf: agentsURL),
           let stored = try? JSONDecoder().decode([AgentRecord].self, from: data) {
            agents = Dictionary(uniqueKeysWithValues: stored.map { ($0.token, $0) })
        }
        if let data = try? Data(contentsOf: devicesURL),
           let stored = try? JSONDecoder().decode([DeviceRecord].self, from: data) {
            devices = Dictionary(uniqueKeysWithValues: stored.map { ($0.deviceId, $0) })
        }
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
