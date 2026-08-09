import XCTest
import Foundation
import DomoProtocol
import DomoTransport
import DomoDeviceCore

/// Phase 2 acceptance (runbook §Phase 2): the client trusts exactly one pinned
/// SPKI, not the system CA store. Includes the reject path — "a pin never tested
/// against a bad cert is not a working pin."
final class PinningTests: XCTestCase {

    // MARK: - Evaluator-level (the exact decision the TLS verify block makes)

    func testSPKIHashMatchesOpenSSL() throws {
        let g = try TestCerts.generate()
        defer { TestCerts.cleanup(g) }
        // Our Security.framework extractor must agree with the canonical OpenSSL
        // SPKI pin — proves the fixed ASN.1 header is correct, not just internally
        // consistent.
        let ours = SPKIPin(derCertificate: g.certDER)?.sha256Base64
        XCTAssertEqual(ours, g.opensslPin)
    }

    func testEvaluatorAcceptsPinnedCertRejectsOthers() throws {
        let good = try TestCerts.generate(cn: "good-broker")
        let bad = try TestCerts.generate(cn: "evil-broker")
        defer { TestCerts.cleanup(good); TestCerts.cleanup(bad) }

        let evaluator = SPKIPinningEvaluator(pins: [SPKIPin(sha256Base64: good.opensslPin)])
        XCTAssertTrue(evaluator.evaluate(derChain: [good.certDER]), "pinned cert must be trusted")
        XCTAssertFalse(evaluator.evaluate(derChain: [bad.certDER]), "a different self-signed cert must be refused")
        XCTAssertFalse(evaluator.evaluate(derChain: []), "empty chain must fail closed")
    }

    // MARK: - Live TLS handshake over the real transport

    func testLiveHandshakeAcceptsPinnedAndRefusesWrongCert() throws {
        let served = try TestCerts.generate(cn: "domo-broker")
        let other = try TestCerts.generate(cn: "domo-broker")   // same CN, different key
        defer { TestCerts.cleanup(served); TestCerts.cleanup(other) }

        guard let identity = TestCerts.loadIdentity(p12: served.p12) else {
            throw XCTSkip("SecPKCS12Import unavailable in this environment; evaluator-level tests cover the pin logic")
        }

        // A wss:// broker presenting `served`. The device dials with a pin on the
        // SERVED cert → must connect and run the full scenario end to end.
        let stack = try NetworkStack(
            serverIdentity: identity,
            deviceTrust: SPKIPinningEvaluator(pins: [SPKIPin(sha256Base64: served.opensslPin)]))
        defer { stack.shutdown() }
        XCTAssertTrue(stack.broker.isDeviceOnline(stack.deviceId),
                      "device should complete the wss handshake against the pinned cert")

        let agent = stack.createAgent(name: "Pinned Agent")
        let client = try NetworkMCPClient(
            dialer: stack.agentDialer(trust: SPKIPinningEvaluator(pins: [SPKIPin(sha256Base64: served.opensslPin)])),
            token: agent.token)
        XCTAssertTrue(client.authOk, "agent should auth over the pinned wss channel")
        try client.initializeSession()
        let (access, _) = try client.callTool("request_device_access", [
            "device": .string(stack.deviceId), "goals": "pinned session",
        ])
        XCTAssertEqual(access["status"].str, "granted")
        client.close()

        // The important test: a dialer that pins the OTHER cert must refuse this
        // broker — the handshake fails, connect() throws.
        let wrongPinDialer = WebSocketDialer(
            url: URL(string: "wss://127.0.0.1:\(stack.agentPort)/")!,
            trust: SPKIPinningEvaluator(pins: [SPKIPin(sha256Base64: other.opensslPin)]),
            timeout: 5)
        XCTAssertThrowsError(try wrongPinDialer.connect(),
                             "a broker presenting an unpinned cert must be refused")
    }
}
