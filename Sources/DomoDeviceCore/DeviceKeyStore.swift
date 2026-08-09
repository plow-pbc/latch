import Foundation
import Security
import DomoProtocol

/// Where the device's identity signing key lives. The file-backed store is the
/// v1 default and the only one exercised by headless tests; the Keychain store
/// is the app-milestone hardening. Both sit behind this seam so the storage
/// upgrade is a drop-in and never touches the signing/verification path
/// (runbook Phase 3, step 1).
///
/// On the Secure Enclave: the Enclave can only hold **P-256** keys, while Domo's
/// identity/signature algorithm is Ed25519 (Curve25519) everywhere — the broker
/// verifies device challenges and agent intents with one algorithm. Rather than
/// fork the signature algorithm just for device keys, the Keychain store keeps
/// the Ed25519 key out of a plaintext JSON file; a genuine
/// `kSecAttrTokenIDSecureEnclave` P-256 store is a future drop-in behind this
/// same protocol if we ever choose to run two algorithms.
public protocol DeviceKeyStore {
    func loadKey() -> KeyPair?
    func storeKey(_ keyPair: KeyPair) throws
}

/// v1 default: the Ed25519 private key persisted in a `0600` JSON file under
/// DOMO_HOME. Matches the historical layout so existing identities keep working.
public struct FileDeviceKeyStore: DeviceKeyStore {
    public let url: URL
    public init(url: URL) { self.url = url }

    private struct Stored: Codable { var privateKeyBase64: String }

    public func loadKey() -> KeyPair? {
        guard let data = try? Data(contentsOf: url),
              let stored = try? JSONDecoder().decode(Stored.self, from: data),
              let raw = Data(base64Encoded: stored.privateKeyBase64),
              let keyPair = try? KeyPair(rawRepresentation: raw) else { return nil }
        return keyPair
    }

    public func storeKey(_ keyPair: KeyPair) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(Stored(privateKeyBase64: keyPair.privateKeyBase64)).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

/// App-milestone hardening: the Ed25519 private key in the macOS Keychain as a
/// generic-password item, so it isn't sitting in a readable file. Conforms to
/// the same seam; the broker sees only the public key at enrollment.
public struct KeychainDeviceKeyStore: DeviceKeyStore {
    public let service: String
    public let account: String

    public init(service: String = "com.tumult.domo.device", account: String = "identity") {
        self.service = service
        self.account = account
    }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func loadKey() -> KeyPair? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let keyPair = try? KeyPair(rawRepresentation: data) else { return nil }
        return keyPair
    }

    public func storeKey(_ keyPair: KeyPair) throws {
        SecItemDelete(baseQuery as CFDictionary)   // idempotent overwrite
        var attrs = baseQuery
        attrs[kSecValueData as String] = keyPair.privateKey.rawRepresentation
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attrs as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw RPCErrorShim("keychain store failed: \(status)")
        }
    }

    public func deleteKey() { SecItemDelete(baseQuery as CFDictionary) }
}

struct RPCErrorShim: Error, CustomStringConvertible {
    let message: String
    init(_ message: String) { self.message = message }
    var description: String { message }
}
