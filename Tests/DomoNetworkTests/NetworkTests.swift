import XCTest
import Foundation
import DomoProtocol
import DomoTransport
import DomoBrokerCore
import DomoDeviceCore

/// Phase 1 acceptance (runbook §Phase 1): the full stack — the real Broker,
/// DeviceAgent, PolicyEngine, Executor and MCP surface — runs unchanged over the
/// WebSocket transport on 127.0.0.1. Nothing above `LineRPC` knows the transport
/// switched.
final class NetworkTests: XCTestCase {
    var stack: NetworkStack!

    override func tearDown() {
        stack?.shutdown()
        stack = nil
        super.tearDown()
    }

    func testFullScenarioOverWebSocket() throws {
        stack = try NetworkStack()
        let agent = stack.createAgent(name: "Net Agent")

        let client = try NetworkMCPClient(dialer: stack.agentDialer(), token: agent.token)
        XCTAssertTrue(client.authOk, "agent auth should succeed over WebSocket")
        try client.initializeSession()

        // Device is discoverable and online over the network.
        let (devices, _) = try client.callTool("list_devices")
        let entry = devices["devices"].arr?.first { $0["id"].str == stack.deviceId }
        XCTAssertEqual(entry?["online"].boolValue, true)
        XCTAssertEqual(entry?["granted"].boolValue, false)

        // Access grant round-trips broker → device → policy → broker.
        let (access, accessError) = try client.callTool("request_device_access", [
            "device": .string(stack.deviceId), "goals": "run the phase-1 scenario",
        ])
        XCTAssertFalse(accessError)
        XCTAssertEqual(access["status"].str, "granted")

        // A signed intent executes sandboxed on the device, over WebSocket.
        let (result, isError) = try client.callTool("run_command", [
            "device": .string(stack.deviceId),
            "argv": ["/bin/echo", "over-websocket"],
        ])
        XCTAssertFalse(isError, "run_command failed: \(result.jsonString())")
        XCTAssertEqual(result["exit_code"].int, 0)
        XCTAssertEqual(result["output"].str, "over-websocket\n")

        let events = stack.auditEvents()
        XCTAssertTrue(events.contains("access_request"))
        XCTAssertTrue(events.contains("exec_start"))
        client.close()
    }

    func testBadTokenRejectedOverWebSocket() throws {
        stack = try NetworkStack()
        let impostor = try NetworkMCPClient(dialer: stack.agentDialer(), token: "not-a-real-token")
        XCTAssertFalse(impostor.authOk)
        XCTAssertTrue(impostor.authRejected)
    }

    func testDeviceReconnectsAfterBrokerBounce() throws {
        // The networked device holds the connection open and re-dials with
        // backoff when the link drops (runbook Phase 1). We prove it by bouncing
        // the whole broker on a FIXED device port: the device, connected with
        // reconnect:true, must come back online against the fresh broker having
        // re-run registration — it assumes no retained broker state.
        let home = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("domo-reconnect-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }

        // Fixed device port so the dialer URL survives the bounce.
        let deviceListener1 = try WebSocketListener(port: 0)
        deviceListener1.start()
        let devicePort = deviceListener1.waitForPort()!
        let agentListener1 = try WebSocketListener(port: 0)
        agentListener1.start()
        let broker1 = try Broker(home: home, agentListener: agentListener1,
                                 deviceListener: deviceListener1,
                                 agentEndpoint: "ws://127.0.0.1:\(agentListener1.waitForPort()!)/")

        let policy = HeadlessPolicy(config: .init(access: "allow", intent: "allow_once"))
        let device = try DeviceAgent(home: home.appendingPathComponent("devhome"),
                                     name: "ReconnectMac", delegate: policy)
        defer { device.disconnect() }
        let dialer = WebSocketDialer(url: URL(string: "ws://127.0.0.1:\(devicePort)/")!)
        try device.connect(dialer: dialer, reconnect: true)

        XCTAssertTrue(waitOnline(broker1, device.identity.deviceId), "device should register with broker1")

        // Bounce: drop broker1, stand up a fresh broker2 on the SAME device port.
        // The old listener's cancel() releases the port asynchronously, so give
        // it a beat before rebinding the identical ephemeral port in-process
        // (production never rebinds the same port this fast).
        broker1.stop()
        Thread.sleep(forTimeInterval: 0.5)
        let deviceListener2 = try WebSocketListener(port: devicePort)
        deviceListener2.start()
        XCTAssertEqual(deviceListener2.waitForPort(), devicePort, "broker2 should rebind the device port")
        let agentListener2 = try WebSocketListener(port: 0)
        agentListener2.start()
        let broker2 = try Broker(home: home, agentListener: agentListener2,
                                 deviceListener: deviceListener2,
                                 agentEndpoint: "ws://127.0.0.1:\(agentListener2.waitForPort()!)/")
        defer { broker2.stop() }

        XCTAssertTrue(waitOnline(broker2, device.identity.deviceId, timeout: 20),
                      "device should re-dial and re-register with the fresh broker")
    }

    private func waitOnline(_ broker: Broker, _ deviceId: String, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if broker.isDeviceOnline(deviceId) { return true }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return false
    }
}
