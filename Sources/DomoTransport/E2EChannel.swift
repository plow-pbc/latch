import Foundation
import CryptoKit
import DomoProtocol

/// End-to-end encrypted, mutually-authenticated channel between an agent and a
/// device — the crown jewel of the security model (runbook Phase 4). The broker
/// relays the handshake and the sealed frames blindly: it holds neither the
/// ephemeral keys nor the identity private keys, so it can neither read nor forge
/// agent↔device payloads. It sees only routing metadata (device id, sizes).
///
/// This is a station-to-station / Noise-XX-equivalent handshake:
///   - each side sends an EPHEMERAL X25519 public key, authenticated by a
///     signature from its long-term Ed25519 identity key (which the peer already
///     pins — the device pins the agent at grant, the agent knows the device's
///     enrolled key);
///   - both derive a shared secret via X25519 ECDH and split it (HKDF-SHA256)
///     into two directional keys;
///   - application frames are sealed with ChaChaPoly (AEAD), so any tampering by
///     the relay breaks the tag and the peer rejects the frame.
///
/// Built on CryptoKit rather than a libsodium/Noise binding (the runbook's
/// suggestion): it keeps Domo's zero-external-dependency posture and reuses the
/// same vetted primitives (X25519, Ed25519, HKDF-SHA256, ChaCha20-Poly1305).
/// Intent signing is unchanged and layered on top — the channel gives
/// confidentiality + channel integrity; the signature gives the device
/// independent per-request authenticity.
public final class E2EChannel {
    public enum Role { case initiator, responder }

    public struct HandshakeError: Error, CustomStringConvertible {
        public let message: String
        public init(_ message: String) { self.message = message }
        public var description: String { message }
    }

    private static let initContext = "domo-e2e-init:v1:"
    private static let respContext = "domo-e2e-resp:v1:"
    private static let hkdfInfoI2R = Data("domo-e2e:i2r".utf8)
    private static let hkdfInfoR2I = Data("domo-e2e:r2i".utf8)

    private let role: Role
    private let ephemeral: Curve25519.KeyAgreement.PrivateKey
    private let identity: KeyPair
    private let expectedPeerIdentity: String

    private var sendKey: SymmetricKey?
    private var recvKey: SymmetricKey?

    public var isEstablished: Bool { sendKey != nil && recvKey != nil }

    private init(role: Role, identity: KeyPair, expectedPeerIdentity: String) {
        self.role = role
        self.ephemeral = Curve25519.KeyAgreement.PrivateKey()
        self.identity = identity
        self.expectedPeerIdentity = expectedPeerIdentity
    }

    // MARK: - Handshake

    /// Agent side. Returns the channel (not yet established) and the first
    /// handshake message to relay to the device.
    public static func initiate(identity: KeyPair,
                                peerIdentityPublicKeyBase64: String) -> (E2EChannel, Data) {
        let channel = E2EChannel(role: .initiator, identity: identity,
                                 expectedPeerIdentity: peerIdentityPublicKeyBase64)
        let ePub = channel.ephemeral.publicKey.rawRepresentation
        let sig = try! identity.sign(Data(initContext.utf8) + ePub)
        let msg: JSONValue = [
            "e": .string(ePub.base64EncodedString()),
            "id": .string(identity.publicKeyBase64),
            "sig": .string(sig.base64EncodedString()),
        ]
        return (channel, msg.encoded())
    }

    /// Device side. Verifies the agent's authenticated ephemeral key, derives the
    /// session keys, and returns the channel (established) plus the response
    /// message to relay back.
    public static func respond(identity: KeyPair,
                               expectedPeerIdentityPublicKeyBase64: String,
                               msg1: Data) throws -> (E2EChannel, Data) {
        let channel = E2EChannel(role: .responder, identity: identity,
                                 expectedPeerIdentity: expectedPeerIdentityPublicKeyBase64)
        guard let m = try? JSONValue.parse(msg1),
              let ePeerB64 = m["e"].str, let ePeer = Data(base64Encoded: ePeerB64),
              let peerId = m["id"].str,
              let sigB64 = m["sig"].str, let sig = Data(base64Encoded: sigB64) else {
            throw HandshakeError("malformed handshake msg1")
        }
        // The initiator must be exactly the identity we expect (pinned), and its
        // ephemeral key must be signed by that identity — a MITM broker can't
        // forge this because it lacks the identity private key.
        guard peerId == expectedPeerIdentityPublicKeyBase64 else {
            throw HandshakeError("unexpected peer identity")
        }
        guard KeyPair.verify(signature: sig, data: Data(initContext.utf8) + ePeer,
                             publicKeyBase64: peerId) else {
            throw HandshakeError("bad initiator signature")
        }
        try channel.deriveKeys(peerEphemeral: ePeer)

        let ePub = channel.ephemeral.publicKey.rawRepresentation
        let sigB = try identity.sign(Data(respContext.utf8) + ePub + ePeer)
        let msg2: JSONValue = [
            "e": .string(ePub.base64EncodedString()),
            "id": .string(identity.publicKeyBase64),
            "sig": .string(sigB.base64EncodedString()),
        ]
        return (channel, msg2.encoded())
    }

    /// Agent side: complete the handshake with the device's response.
    public func receiveResponse(_ msg2: Data) throws {
        guard role == .initiator else { throw HandshakeError("wrong role for receiveResponse") }
        guard let m = try? JSONValue.parse(msg2),
              let ePeerB64 = m["e"].str, let ePeer = Data(base64Encoded: ePeerB64),
              let peerId = m["id"].str,
              let sigB64 = m["sig"].str, let sig = Data(base64Encoded: sigB64) else {
            throw HandshakeError("malformed handshake msg2")
        }
        guard peerId == expectedPeerIdentity else {
            throw HandshakeError("unexpected peer identity")
        }
        let myEphemeral = ephemeral.publicKey.rawRepresentation
        guard KeyPair.verify(signature: sig,
                             data: Data(Self.respContext.utf8) + ePeer + myEphemeral,
                             publicKeyBase64: peerId) else {
            throw HandshakeError("bad responder signature")
        }
        try deriveKeys(peerEphemeral: ePeer)
    }

    private func deriveKeys(peerEphemeral: Data) throws {
        guard let peerKey = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerEphemeral),
              let shared = try? ephemeral.sharedSecretFromKeyAgreement(with: peerKey) else {
            throw HandshakeError("key agreement failed")
        }
        // Salt binds both ephemerals; distinct info labels split the secret into
        // two directional keys so the two directions never share a keystream.
        let myEph = ephemeral.publicKey.rawRepresentation
        let salt = (role == .initiator) ? myEph + peerEphemeral : peerEphemeral + myEph
        let i2r = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
                                                 sharedInfo: Self.hkdfInfoI2R, outputByteCount: 32)
        let r2i = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
                                                 sharedInfo: Self.hkdfInfoR2I, outputByteCount: 32)
        switch role {
        case .initiator: sendKey = i2r; recvKey = r2i
        case .responder: sendKey = r2i; recvKey = i2r
        }
    }

    // MARK: - Sealed frames

    /// Seal a plaintext payload for the peer. The returned bytes are what the
    /// broker relays — nonce + ciphertext + tag, no plaintext recoverable
    /// without the session key.
    public func seal(_ plaintext: Data) throws -> Data {
        guard let sendKey else { throw HandshakeError("channel not established") }
        let box = try ChaChaPoly.seal(plaintext, using: sendKey)
        return box.combined
    }

    /// Open a sealed frame from the peer. Throws (never returns plaintext) if the
    /// relay tampered with any byte — the AEAD tag fails, so the device rejects
    /// and never acts on it.
    public func open(_ frame: Data) throws -> Data {
        guard let recvKey else { throw HandshakeError("channel not established") }
        let box = try ChaChaPoly.SealedBox(combined: frame)
        return try ChaChaPoly.open(box, using: recvKey)
    }
}
