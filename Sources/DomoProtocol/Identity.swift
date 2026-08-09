import Foundation
import CryptoKit

/// Ed25519 keypair with a stable fingerprint identity.
/// v1 stores keys as files under DOMO_HOME; the app milestone moves the device
/// key into Keychain/Secure Enclave (see DESIGN.md §8).
public struct KeyPair {
    public let privateKey: Curve25519.Signing.PrivateKey

    public init() {
        privateKey = Curve25519.Signing.PrivateKey()
    }

    public init(rawRepresentation: Data) throws {
        privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: rawRepresentation)
    }

    public var publicKeyBase64: String {
        privateKey.publicKey.rawRepresentation.base64EncodedString()
    }

    public var privateKeyBase64: String {
        privateKey.rawRepresentation.base64EncodedString()
    }

    /// Stable short identity derived from the public key.
    public var fingerprint: String {
        Self.fingerprint(ofPublicKeyBase64: publicKeyBase64)
    }

    public static func fingerprint(ofPublicKeyBase64 publicKey: String) -> String {
        let digest = SHA256.hash(data: Data(publicKey.utf8))
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    public func sign(_ data: Data) throws -> Data {
        try privateKey.signature(for: data)
    }

    public static func verify(signature: Data, data: Data, publicKeyBase64: String) -> Bool {
        guard let keyData = Data(base64Encoded: publicKeyBase64),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData) else {
            return false
        }
        return key.isValidSignature(signature, for: data)
    }
}

public enum Hashing {
    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
