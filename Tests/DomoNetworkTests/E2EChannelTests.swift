import XCTest
import Foundation
import CryptoKit
import DomoProtocol
import DomoTransport

/// Phase 4 acceptance (runbook §Phase 4): the agent↔device channel is end-to-end
/// encrypted and authenticated; the broker is a blind relay. A tampered frame is
/// rejected (never executed); a captured transcript yields no plaintext.
final class E2EChannelTests: XCTestCase {

    /// Establish both ends through a relay that only ever sees the (public)
    /// handshake bytes — exactly what the broker forwards.
    private func establishPair() throws -> (agent: E2EChannel, device: E2EChannel,
                                            agentKey: KeyPair, deviceKey: KeyPair,
                                            transcript: [Data]) {
        let agentKey = KeyPair()
        let deviceKey = KeyPair()
        var transcript: [Data] = []

        // Agent initiates; it knows the device's enrolled identity key.
        let (agent, msg1) = E2EChannel.initiate(identity: agentKey,
                                                peerIdentityPublicKeyBase64: deviceKey.publicKeyBase64)
        transcript.append(msg1)
        // Broker relays msg1 to the device, which knows the agent's pinned key.
        let (device, msg2) = try E2EChannel.respond(identity: deviceKey,
                                                    expectedPeerIdentityPublicKeyBase64: agentKey.publicKeyBase64,
                                                    msg1: msg1)
        transcript.append(msg2)
        try agent.receiveResponse(msg2)

        XCTAssertTrue(agent.isEstablished)
        XCTAssertTrue(device.isEstablished)
        return (agent, device, agentKey, deviceKey, transcript)
    }

    func testHandshakeAndBidirectionalRoundTrip() throws {
        let p = try establishPair()
        let toDevice = Data("intent: run echo".utf8)
        let opened = try p.device.open(try p.agent.seal(toDevice))
        XCTAssertEqual(opened, toDevice)

        let toAgent = Data("result: exit 0".utf8)
        let openedBack = try p.agent.open(try p.device.seal(toAgent))
        XCTAssertEqual(openedBack, toAgent)
    }

    func testTamperedFrameIsRejected() throws {
        let p = try establishPair()
        let plaintext = Data("run: rm -rf /tmp/secret".utf8)
        var frame = try p.agent.seal(plaintext)

        // A malicious/buggy broker flips one byte of the relayed ciphertext.
        frame[frame.count / 2] ^= 0x01
        XCTAssertThrowsError(try p.device.open(frame),
                             "AEAD tag must fail on tamper — the device never sees the plaintext")

        // A pristine frame still opens: the rejection was the tampering, not the channel.
        XCTAssertEqual(try p.device.open(try p.agent.seal(plaintext)), plaintext)
    }

    func testBrokerCannotRecoverPlaintextFromTranscript() throws {
        let p = try establishPair()
        let secret = "SUPER-SECRET-PAYLOAD-\(UUID().uuidString)"
        let frame = try p.agent.seal(Data(secret.utf8))

        // Everything the broker sees: the handshake transcript + the sealed frame.
        let wireBytes = (p.transcript + [frame]).reduce(Data(), +)
        XCTAssertFalse(wireBytes.range(of: Data(secret.utf8)) != nil,
                       "plaintext must not appear anywhere on the wire")

        // The broker has neither ephemeral nor identity private key, so even a
        // fresh responder built from the transcript can't reconstruct the session
        // (it would need the device identity key). Concretely: a wrong key can't open.
        let attacker = SymmetricKey(size: .bits256)
        XCTAssertThrowsError(try ChaChaPoly.open(try ChaChaPoly.SealedBox(combined: frame), using: attacker))
    }

    func testMITMBrokerSubstitutingEphemeralIsRejected() throws {
        let agentKey = KeyPair()
        let deviceKey = KeyPair()
        let (_, msg1) = E2EChannel.initiate(identity: agentKey,
                                            peerIdentityPublicKeyBase64: deviceKey.publicKeyBase64)

        // Broker tries to MITM: replace the agent's ephemeral with its own. It
        // cannot re-sign with the agent identity key, so the tampered msg1 fails.
        var m = try XCTUnwrap(try? JSONValue.parse(msg1))
        let brokerEph = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
        if case .object(var obj) = m {
            obj["e"] = .string(brokerEph.base64EncodedString())
            m = .object(obj)
        }
        XCTAssertThrowsError(try E2EChannel.respond(
            identity: deviceKey,
            expectedPeerIdentityPublicKeyBase64: agentKey.publicKeyBase64,
            msg1: m.encoded()), "a substituted ephemeral must fail signature verification")
    }

    func testWrongExpectedPeerIdentityIsRejected() throws {
        let agentKey = KeyPair()
        let deviceKey = KeyPair()
        let strangerKey = KeyPair()
        let (_, msg1) = E2EChannel.initiate(identity: agentKey,
                                            peerIdentityPublicKeyBase64: deviceKey.publicKeyBase64)
        // Device expected a DIFFERENT agent than the one that connected.
        XCTAssertThrowsError(try E2EChannel.respond(
            identity: deviceKey,
            expectedPeerIdentityPublicKeyBase64: strangerKey.publicKeyBase64,
            msg1: msg1))
    }

    // MARK: - Full blind-relay of a real signed Intent

    /// The end-to-end property: the agent builds and SIGNS a real Intent, seals
    /// it, and a blind relay forwards ciphertext. The device decrypts, and only
    /// then verifies the signature and would execute. Intent signing is kept
    /// (channel = confidentiality/integrity; signature = per-request authenticity).
    func testSignedIntentSurvivesBlindRelayAndTamperIsRejected() throws {
        let p = try establishPair()

        // Agent endpoint builds + signs a real intent (this is what moves off the
        // broker in the production wiring; here the agent holds its own key).
        var intent = Intent(agentId: p.agentKey.fingerprint, agentDisplay: "E2E Agent",
                            agentPublicKey: p.agentKey.publicKeyBase64,
                            deviceId: p.deviceKey.fingerprint, goal: "prove blind relay",
                            planContext: nil, request: "run: rm -rf /tmp/secret",
                            capabilities: [Capability(kind: .processExec, argv: ["/bin/echo", "hi"])],
                            sessionId: "s1")
        try intent.sign(with: p.agentKey)
        let payload = JSONValue.from(intent)
        let sealed = try p.agent.seal(payload.encoded())

        // Blind relay: it must not be able to read the intent.
        XCTAssertFalse(sealed.range(of: Data("rm -rf /tmp/secret".utf8)) != nil,
                       "the relay must not see the request text")

        // Device decrypts, decodes, and verifies the still-signed intent.
        let openedData = try p.device.open(sealed)
        let decoded = try JSONValue.parse(openedData).decode(Intent.self)
        XCTAssertTrue(decoded.verifySignature(), "signed intent verifies after decryption")
        XCTAssertEqual(decoded.agentPublicKey, p.agentKey.publicKeyBase64)

        // Tamper path: a relay that flips a byte → open fails → the intent never
        // reaches signature verification or execution.
        var tampered = sealed
        tampered[tampered.count - 1] ^= 0x01
        XCTAssertThrowsError(try p.device.open(tampered),
                             "tampered intent frame is rejected before decode/verify/execute")
    }
}
