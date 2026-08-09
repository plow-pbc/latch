import XCTest
import Foundation
import DomoProtocol
import DomoTransport
import DomoDeviceCore

/// Phase 5 acceptance (runbook §Phase 5): revoking a grant takes effect
/// immediately — the broker stops routing and drops live sessions, and the
/// device refuses the agent's intents even if a stale broker keeps routing them.
final class RevocationTests: XCTestCase {
    var stack: NetworkStack!

    override func tearDown() {
        stack?.shutdown(); stack = nil; super.tearDown()
    }

    func testBrokerStopsRoutingAndDropsLiveSession() throws {
        stack = try NetworkStack()
        let agent = stack.createAgent(name: "Revokee")
        let client = try NetworkMCPClient(dialer: stack.agentDialer(), token: agent.token)
        try client.initializeSession()
        _ = try client.callTool("request_device_access", [
            "device": .string(stack.deviceId), "goals": "will be revoked",
        ])
        let (ok, okErr) = try client.callTool("run_command", [
            "device": .string(stack.deviceId), "argv": ["/bin/echo", "before"],
        ])
        XCTAssertFalse(okErr)
        XCTAssertEqual(ok["output"].str, "before\n")

        // Provisioner revokes mid-session.
        stack.broker.revokeAgent(agent.agentId)

        // Live session is dropped.
        let dropDeadline = Date().addingTimeInterval(3)
        while Date() < dropDeadline && !client.isClosed { Thread.sleep(forTimeInterval: 0.02) }
        XCTAssertTrue(client.isClosed, "revocation must drop the live agent session")

        // The device was told to revoke (so it rejects even a stale broker).
        XCTAssertTrue(stack.auditEvents().contains("agent_revoked"),
                      "device should be notified of the revocation")

        // A reconnect with the same token is refused all routing.
        let retry = try NetworkMCPClient(dialer: stack.agentDialer(), token: agent.token)
        try retry.initializeSession()
        let (result, isError) = try retry.callTool("run_command", [
            "device": .string(stack.deviceId), "argv": ["/bin/echo", "after"],
        ])
        XCTAssertTrue(isError, "broker must refuse to route for a revoked agent")
        XCTAssertTrue((result.str ?? "").lowercased().contains("revoked"))
        retry.close()
    }

    func testDeviceRejectsRevokedAgentEvenIfStaleBrokerRoutes() throws {
        stack = try NetworkStack()
        let agent = stack.createAgent(name: "Stale-Routed")
        let client = try NetworkMCPClient(dialer: stack.agentDialer(), token: agent.token)
        try client.initializeSession()
        _ = try client.callTool("request_device_access", [
            "device": .string(stack.deviceId), "goals": "device-authoritative revoke",
        ])

        // Revoke ONLY on the device — the broker still thinks the agent is fine
        // (a stale/hostile broker). The device must reject on its own authority.
        stack.device.revokeAgent(agentId: agent.agentId)

        let (result, isError) = try client.callTool("run_command", [
            "device": .string(stack.deviceId), "argv": ["/bin/echo", "should-not-run"],
        ])
        XCTAssertTrue(isError, "device must reject a revoked agent's intent")

        // The device audited a rejection with the revocation reason and never
        // started execution for it.
        let events = stack.rawAuditEvents()
        let rejected = events.first {
            $0["event"].str == "intent_rejected" && $0["reason"].str == "revoked agent"
        }
        XCTAssertNotNil(rejected, "device should record intent_rejected: revoked agent")
    }

    func testKnownAgentsRevocationIsAuthoritativeAndPersists() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("domo-known-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("known_agents.json")

        let agentKey = KeyPair()
        let known = KnownAgents(url: url)
        known.pin(agentId: agentKey.fingerprint, publicKey: agentKey.publicKeyBase64)
        XCTAssertEqual(known.publicKey(for: agentKey.fingerprint), agentKey.publicKeyBase64)

        known.revoke(agentId: agentKey.fingerprint)
        XCTAssertNil(known.publicKey(for: agentKey.fingerprint))
        XCTAssertTrue(known.isRevoked(agentKey.fingerprint))

        // A stale broker can't silently re-pin a revoked agent.
        known.pin(agentId: agentKey.fingerprint, publicKey: agentKey.publicKeyBase64)
        XCTAssertNil(known.publicKey(for: agentKey.fingerprint))

        // Revocation survives reload.
        let reloaded = KnownAgents(url: url)
        XCTAssertTrue(reloaded.isRevoked(agentKey.fingerprint))
        XCTAssertNil(reloaded.publicKey(for: agentKey.fingerprint))
    }
}
