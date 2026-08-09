import Foundation
import DomoProtocol

/// Device identity persisted under DOMO_HOME. File-backed Ed25519 for v1;
/// Keychain/Secure Enclave is the app-milestone upgrade (DESIGN.md §8).
public struct DeviceIdentity {
    public let deviceId: String
    public let name: String
    public let keyPair: KeyPair

    private struct Stored: Codable {
        var deviceId: String
        var name: String
        var privateKeyBase64: String
    }

    public static func loadOrCreate(home: URL, defaultName: String) throws -> DeviceIdentity {
        let url = home.appendingPathComponent("device/identity.json")
        if let data = try? Data(contentsOf: url),
           let stored = try? JSONDecoder().decode(Stored.self, from: data),
           let keyData = Data(base64Encoded: stored.privateKeyBase64),
           let keyPair = try? KeyPair(rawRepresentation: keyData) {
            return DeviceIdentity(deviceId: stored.deviceId, name: stored.name, keyPair: keyPair)
        }
        let keyPair = KeyPair()
        let identity = DeviceIdentity(deviceId: keyPair.fingerprint, name: defaultName, keyPair: keyPair)
        let stored = Stored(deviceId: identity.deviceId, name: defaultName,
                            privateKeyBase64: keyPair.privateKeyBase64)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(stored).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return identity
    }
}

/// Agent public keys pinned at access-grant time. Intents are only accepted
/// from keys pinned here (TOFU via the local broker in v1; DESIGN.md §8).
public final class KnownAgents {
    private let url: URL
    private let lock = NSLock()
    private var keys: [String: String] // agentId -> publicKeyBase64

    public init(url: URL) {
        self.url = url
        if let data = try? Data(contentsOf: url),
           let stored = try? JSONDecoder().decode([String: String].self, from: data) {
            keys = stored
        } else {
            keys = [:]
        }
    }

    public func pin(agentId: String, publicKey: String) {
        lock.lock()
        keys[agentId] = publicKey
        let snapshot = keys
        lock.unlock()
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? encoder.encode(snapshot).write(to: url)
    }

    public func publicKey(for agentId: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return keys[agentId]
    }
}
