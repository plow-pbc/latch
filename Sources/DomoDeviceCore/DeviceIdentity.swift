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

    /// Load/create using an injected `DeviceKeyStore` (runbook Phase 3, step 1).
    /// The signing key lives in the store (file or Keychain); only public
    /// metadata (deviceId, name) is written to `identity-meta.json`. The deviceId
    /// still derives from the public key, so it is stable across storage choices.
    public static func loadOrCreate(home: URL, defaultName: String,
                                    keyStore: DeviceKeyStore) throws -> DeviceIdentity {
        let keyPair: KeyPair
        if let existing = keyStore.loadKey() {
            keyPair = existing
        } else {
            keyPair = KeyPair()
            try keyStore.storeKey(keyPair)
        }
        let metaURL = home.appendingPathComponent("device/identity-meta.json")
        struct Meta: Codable { var deviceId: String; var name: String }
        var name = defaultName
        if let data = try? Data(contentsOf: metaURL),
           let meta = try? JSONDecoder().decode(Meta.self, from: data) {
            name = meta.name
        } else {
            try FileManager.default.createDirectory(at: metaURL.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try? encoder.encode(Meta(deviceId: keyPair.fingerprint, name: defaultName)).write(to: metaURL)
        }
        return DeviceIdentity(deviceId: keyPair.fingerprint, name: name, keyPair: keyPair)
    }
}

/// Agent public keys pinned at access-grant time. Intents are only accepted
/// from keys pinned here (TOFU via the local broker in v1; DESIGN.md §8).
///
/// Revocation is authoritative on the DEVICE: once an agent is revoked here its
/// key is dropped AND it is remembered as revoked, so a stale or hostile broker
/// that re-routes (or tries to re-pin) that agent's intents is still refused —
/// the device does not depend on the broker for revocation (runbook Phase 5).
public final class KnownAgents {
    private let url: URL
    private let lock = NSLock()
    private var keys: [String: String] // agentId -> publicKeyBase64
    private var revoked: Set<String>

    private struct Stored: Codable {
        var keys: [String: String]
        var revoked: [String]?
    }

    public init(url: URL) {
        self.url = url
        if let data = try? Data(contentsOf: url),
           let stored = try? JSONDecoder().decode(Stored.self, from: data) {
            keys = stored.keys
            revoked = Set(stored.revoked ?? [])
        } else if let data = try? Data(contentsOf: url),
                  let legacy = try? JSONDecoder().decode([String: String].self, from: data) {
            // Back-compat with the pre-revocation on-disk format (a bare map).
            keys = legacy
            revoked = []
        } else {
            keys = [:]
            revoked = []
        }
    }

    public func pin(agentId: String, publicKey: String) {
        lock.lock()
        // A revoked agent can never be silently re-pinned by the broker.
        if revoked.contains(agentId) { lock.unlock(); return }
        keys[agentId] = publicKey
        lock.unlock()
        persist()
    }

    /// Revoke an agent: drop its key and remember the revocation permanently.
    public func revoke(agentId: String) {
        lock.lock()
        keys.removeValue(forKey: agentId)
        revoked.insert(agentId)
        lock.unlock()
        persist()
    }

    public func isRevoked(_ agentId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return revoked.contains(agentId)
    }

    public func publicKey(for agentId: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        if revoked.contains(agentId) { return nil }
        return keys[agentId]
    }

    private func persist() {
        lock.lock()
        let snapshot = Stored(keys: keys, revoked: Array(revoked))
        lock.unlock()
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? encoder.encode(snapshot).write(to: url)
    }
}
