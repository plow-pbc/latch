import XCTest
import Foundation
import DomoProtocol
import DomoTransport
import DomoDeviceCore

/// Phase 6 acceptance (runbook §Phase 6): the full hosted posture, combined. A
/// broker serving `wss://` with a self-signed cert; the Mac dials OUT and pins
/// that cert, authenticates via the enrollment challenge; an agent elsewhere
/// drives it end to end with approvals. This is the deployment configuration the
/// runbook documents, exercised in-process (real TLS + pin + challenge on
/// loopback stands in for real hosting/NAT).
final class HostedBrokerTests: XCTestCase {

    func testHostedConfigurationEndToEnd() throws {
        let cert = try TestCerts.generate(cn: "domo-broker")
        defer { TestCerts.cleanup(cert) }
        guard let identity = TestCerts.loadIdentity(p12: cert.p12) else {
            throw XCTSkip("SecPKCS12Import unavailable here")
        }
        let pin = SPKIPinningEvaluator(pins: [SPKIPin(sha256Base64: cert.opensslPin)])

        // wss + pinned + enrollment — everything a hosted broker turns on.
        let stack = try NetworkStack(serverIdentity: identity, deviceTrust: pin,
                                     requireEnrollment: true)
        defer { stack.shutdown() }
        XCTAssertTrue(stack.broker.isDeviceOnline(stack.deviceId),
                      "Mac should dial out, pin the cert, pass the challenge, and register")

        // An agent elsewhere connects (pinning the same cert) and drives the Mac.
        let agent = stack.createAgent(name: "Remote Agent")
        let client = try NetworkMCPClient(dialer: stack.agentDialer(trust: pin), token: agent.token)
        XCTAssertTrue(client.authOk)
        try client.initializeSession()

        let (access, _) = try client.callTool("request_device_access", [
            "device": .string(stack.deviceId), "goals": "drive the hosted Mac",
        ])
        XCTAssertEqual(access["status"].str, "granted")

        let (result, isError) = try client.callTool("run_command", [
            "device": .string(stack.deviceId), "argv": ["/bin/echo", "hosted"],
        ])
        XCTAssertFalse(isError, "hosted end-to-end run failed: \(result.jsonString())")
        XCTAssertEqual(result["output"].str, "hosted\n")
        client.close()
    }
}
