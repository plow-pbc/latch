import Foundation

/// Connect-time challenge/response: the broker sends a fresh nonce, the device
/// signs it with its identity key, and the broker verifies against the public
/// key registered at enrollment (runbook Phase 3). This authenticates *who* is
/// connecting, replacing "trust because it reached my socket". Pure crypto so
/// both the broker and the device can share it; no I/O.
public enum DeviceChallenge {
    /// Domain-separation prefix so a device signature over a challenge can never
    /// be mistaken for a signature over anything else (e.g. an intent).
    public static let context = "domo-device-challenge:v1:"

    public static func signingData(nonce: String) -> Data {
        Data((context + nonce).utf8)
    }

    public static func sign(nonce: String, keyPair: KeyPair) throws -> String {
        try keyPair.sign(signingData(nonce: nonce)).base64EncodedString()
    }

    public static func verify(nonce: String, signatureBase64: String,
                              publicKeyBase64: String) -> Bool {
        guard let sig = Data(base64Encoded: signatureBase64) else { return false }
        return KeyPair.verify(signature: sig, data: signingData(nonce: nonce),
                              publicKeyBase64: publicKeyBase64)
    }

    /// A fresh, single-use nonce for one connection attempt.
    public static func newNonce() -> String {
        UUID().uuidString + UUID().uuidString
    }
}
