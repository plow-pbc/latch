import XCTest
import DomoProtocol

/// Full-stack scenarios: real broker process, real headless device process,
/// real MCP traffic. Each test boots a fresh stack in a throwaway DOMO_HOME.
final class E2ETests: XCTestCase {
    var stack: TestStack!

    override func tearDown() {
        stack?.shutdown()
        stack = nil
        super.tearDown()
    }

    func makeStack(policy: [String: JSONValue] = ["access": "allow", "intent": "allow_once"])
        throws -> (TestStack, MCPTestClient) {
        let stack = TestStack()
        self.stack = stack
        let agent = try stack.createAgent(name: "E2E Agent")
        try stack.startBroker()
        try stack.startDevice(policy: policy)
        let client = try MCPTestClient(socket: stack.agentSocket, token: agent.token)
        XCTAssertTrue(client.authOk, "agent auth should succeed")
        try client.initializeSession()
        return (stack, client)
    }

    func requestAccess(_ client: MCPTestClient, _ stack: TestStack,
                       goals: String = "run E2E test scenarios") throws {
        let (result, isError) = try client.callTool("request_device_access", [
            "device": .string(stack.deviceId), "goals": .string(goals),
        ])
        XCTAssertFalse(isError)
        XCTAssertEqual(result["status"].str, "granted")
    }

    // MARK: - Scenarios

    func testDiscoveryAndAccessGrant() throws {
        let (stack, client) = try makeStack()

        // tools/list advertises the device-addressed surface.
        let tools = try client.request("tools/list")
        let names = (tools["result"]["tools"].arr ?? []).compactMap { $0["name"].str }
        XCTAssertTrue(names.contains("run_command"))
        XCTAssertTrue(names.contains("request_device_access"))

        // Device is visible and online but not yet granted.
        let (devices, _) = try client.callTool("list_devices")
        let entry = devices["devices"].arr?.first { $0["id"].str == stack.deviceId }
        XCTAssertNotNil(entry)
        XCTAssertEqual(entry?["online"].boolValue, true)
        XCTAssertEqual(entry?["granted"].boolValue, false)

        // Operations before a grant are refused at the broker.
        let (_, deniedEarly) = try client.callTool("read_file", [
            "device": .string(stack.deviceId), "path": "/tmp/x",
        ])
        XCTAssertTrue(deniedEarly)

        try requestAccess(client, stack)
        let (after, _) = try client.callTool("list_devices")
        let grantedEntry = after["devices"].arr?.first { $0["id"].str == stack.deviceId }
        XCTAssertEqual(grantedEntry?["granted"].boolValue, true)

        // The device audited the access request and decision.
        let events = stack.auditEvents().compactMap { $0["event"].str }
        XCTAssertTrue(events.contains("access_request"))
        XCTAssertTrue(events.contains("access_decision"))
    }

    func testFileRoundTripAndScopeEnforcement() throws {
        let (stack, client) = try makeStack()
        try requestAccess(client, stack)
        let workdir = stack.home.appendingPathComponent("work")
        let file = workdir.appendingPathComponent("note.txt").path

        let (written, writeError) = try client.callTool("write_file", [
            "device": .string(stack.deviceId), "path": .string(file),
            "content": "hello from the agent", "goal": "test write",
        ])
        XCTAssertFalse(writeError)
        XCTAssertEqual(written["bytes"].int, 20)

        let (read, readError) = try client.callTool("read_file", [
            "device": .string(stack.deviceId), "path": .string(file),
        ])
        XCTAssertFalse(readError)
        XCTAssertEqual(read["content"].str, "hello from the agent")

        let events = stack.auditEvents().compactMap { $0["event"].str }
        XCTAssertTrue(events.contains("file_write"))
        XCTAssertTrue(events.contains("file_read"))
    }

    func testRunCommandSandboxed() throws {
        let (stack, client) = try makeStack()
        try requestAccess(client, stack)
        let workdir = stack.home.appendingPathComponent("work")
        try FileManager.default.createDirectory(at: workdir, withIntermediateDirectories: true)

        let target = workdir.appendingPathComponent("made-by-agent.txt").path
        let (result, isError) = try client.callTool("run_command", [
            "device": .string(stack.deviceId),
            "argv": ["/bin/sh", "-c", .string("echo sandboxed > \(target) && cat \(target)")],
            "write_paths": [.string(workdir.path)],
            "goal": "prove exec works",
        ])
        XCTAssertFalse(isError, "run_command failed: \(result.jsonString())")
        XCTAssertEqual(result["status"].str, "completed")
        XCTAssertEqual(result["exit_code"].int, 0)
        XCTAssertEqual(result["output"].str, "sandboxed\n")
        XCTAssertEqual(try String(contentsOfFile: target, encoding: .utf8), "sandboxed\n")
    }

    func testSandboxBlocksUndeclaredWrite() throws {
        let (stack, client) = try makeStack()
        try requestAccess(client, stack)
        let declared = stack.home.appendingPathComponent("declared")
        let undeclared = stack.home.appendingPathComponent("undeclared")
        try FileManager.default.createDirectory(at: declared, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: undeclared, withIntermediateDirectories: true)
        let escape = undeclared.appendingPathComponent("escape.txt").path

        // The command tries to write somewhere it never declared: the human
        // approved [declared], so seatbelt must block [undeclared].
        let (result, _) = try client.callTool("run_command", [
            "device": .string(stack.deviceId),
            "argv": ["/bin/sh", "-c", .string("echo gotcha > \(escape)")],
            "write_paths": [.string(declared.path)],
        ])
        XCTAssertEqual(result["status"].str, "completed")
        XCTAssertNotEqual(result["exit_code"].int, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: escape),
                       "sandbox must prevent writes outside the approved capability set")
    }

    func testStreamingOutput() throws {
        let (stack, client) = try makeStack()
        try requestAccess(client, stack)

        let (started, isError) = try client.callTool("run_command", [
            "device": .string(stack.deviceId),
            "argv": ["/bin/sh", "-c", "echo begin; sleep 1; echo end"],
            "wait_ms": 300,
        ])
        XCTAssertFalse(isError)
        XCTAssertEqual(started["status"].str, "running")
        let handle = started["handle"].str
        XCTAssertNotNil(handle)
        XCTAssertTrue((started["output"].str ?? "").contains("begin"))

        var seen = started["output_length"].int ?? 0
        var tail = ""
        var finished = false
        for _ in 0..<50 {
            let (chunk, chunkError) = try client.callTool("get_output", [
                "device": .string(stack.deviceId),
                "handle": .string(handle!),
                "since": .number(Double(seen)),
            ])
            XCTAssertFalse(chunkError)
            tail += chunk["output"].str ?? ""
            seen = chunk["output_length"].int ?? seen
            if chunk["status"].str == "completed" {
                XCTAssertEqual(chunk["exit_code"].int, 0)
                finished = true
                break
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTAssertTrue(finished, "command should complete")
        XCTAssertTrue(tail.contains("end"))
        XCTAssertFalse(tail.contains("begin"), "since-offset should not resend seen output")
    }

    func testAlwaysAllowRuleReuse() throws {
        let (stack, client) = try makeStack(policy: ["access": "allow", "intent": "always_allow"])
        try requestAccess(client, stack)

        for _ in 0..<2 {
            let (result, isError) = try client.callTool("run_command", [
                "device": .string(stack.deviceId),
                "argv": ["/bin/echo", "repeat"],
            ])
            XCTAssertFalse(isError)
            XCTAssertEqual(result["exit_code"].int, 0)
        }

        // First decision came from the prompt (and stored a rule); the second
        // identical capability set must be served by the rule.
        let sources = stack.auditEvents()
            .filter { $0["event"].str == "intent_decision" }
            .compactMap { $0["source"].str }
        XCTAssertEqual(sources, ["prompt", "rule"])

        // A different argv is a different rule key → prompt again.
        _ = try client.callTool("run_command", [
            "device": .string(stack.deviceId),
            "argv": ["/bin/echo", "different"],
        ])
        let sourcesAfter = stack.auditEvents()
            .filter { $0["event"].str == "intent_decision" }
            .compactMap { $0["source"].str }
        XCTAssertEqual(sourcesAfter, ["prompt", "rule", "prompt"])
    }

    func testDenialFlow() throws {
        let (stack, client) = try makeStack(policy: [
            "access": "allow", "intent": "allow_once",
            "denyKinds": ["process.exec"],
        ])
        try requestAccess(client, stack)

        let target = stack.home.appendingPathComponent("never.txt").path
        let (result, isError) = try client.callTool("run_command", [
            "device": .string(stack.deviceId),
            "argv": ["/bin/sh", "-c", .string("echo no > \(target)")],
            "write_paths": [.string(stack.home.path)],
        ])
        XCTAssertTrue(isError)
        XCTAssertTrue((result.str ?? "").contains("denied"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target))

        // File ops (fs.write) are not in denyKinds, so they still work —
        // the denial was capability-specific, not a blanket block.
        let (_, writeError) = try client.callTool("write_file", [
            "device": .string(stack.deviceId), "path": .string(target), "content": "ok",
        ])
        XCTAssertFalse(writeError)
    }

    func testAccessDeniedByOwner() throws {
        let (stack, client) = try makeStack(policy: ["access": "deny", "intent": "deny"])
        let (result, isError) = try client.callTool("request_device_access", [
            "device": .string(stack.deviceId), "goals": "up to no good",
        ])
        XCTAssertFalse(isError)
        XCTAssertEqual(result["status"].str, "denied")

        let (_, opError) = try client.callTool("read_file", [
            "device": .string(stack.deviceId), "path": "/tmp/x",
        ])
        XCTAssertTrue(opError, "no grant means no operations")
    }

    func testBlessedTools() throws {
        let (stack, client) = try makeStack()
        try requestAccess(client, stack)

        let (tools, listError) = try client.callTool("list_device_tools", [
            "device": .string(stack.deviceId),
        ])
        XCTAssertFalse(listError)
        let names = (tools["tools"].arr ?? []).compactMap { $0["name"].str }
        XCTAssertTrue(names.contains("mac_info"))

        let (result, useError) = try client.callTool("use_tool", [
            "device": .string(stack.deviceId), "tool": "mac_info",
        ])
        XCTAssertFalse(useError)
        XCTAssertNotNil(result["result"]["hostname"].str)
        XCTAssertNotNil(result["result"]["os_version"].str)
    }

    func testAgentCreatedAfterBrokerStartWorks() throws {
        // Regression: a broker loads its agent registry at startup. An agent
        // minted by a separate `create-agent` process afterward must still be
        // able to authenticate (BrokerStore reloads on a lookup miss).
        let stack = TestStack()
        self.stack = stack
        try stack.startBroker()
        try stack.startDevice()
        let late = try stack.createAgent(name: "Late Agent")   // after startBroker

        let client = try MCPTestClient(socket: stack.agentSocket, token: late.token)
        XCTAssertTrue(client.authOk, "agent created after broker start should authenticate")
        try client.initializeSession()
        let (result, isError) = try client.callTool("request_device_access", [
            "device": .string(stack.deviceId), "goals": "late arrival",
        ])
        XCTAssertFalse(isError)
        XCTAssertEqual(result["status"].str, "granted")
        client.close()
    }

    func testBadTokenRejected() throws {
        let stack = TestStack()
        self.stack = stack
        _ = try stack.createAgent(name: "Real Agent")
        try stack.startBroker()
        let impostor = try MCPTestClient(socket: stack.agentSocket, token: "stolen-token")
        XCTAssertFalse(impostor.authOk)
        XCTAssertTrue(impostor.authRejected)
    }

    func testSpawnAgentFlow() throws {
        // The Mac-initiated flow: the device asks the broker to mint a
        // pre-approved agent and pins its key. That agent can immediately
        // operate WITHOUT a separate request_device_access, because the user
        // launching it from their own Mac is the approval.
        let stack = TestStack()
        self.stack = stack
        try stack.startBroker()
        let tokenOut = stack.home.appendingPathComponent("spawn-token.json").path
        try stack.startDevice(spawnGoal: "organize my Downloads folder",
                              spawnTokenOut: tokenOut)

        let spawned = try JSONValue.parse(Data(contentsOf: URL(fileURLWithPath: tokenOut)))
        let token = spawned["token"].str
        XCTAssertNotNil(token)

        let client = try MCPTestClient(socket: stack.agentSocket, token: token!)
        XCTAssertTrue(client.authOk)
        try client.initializeSession()

        // Already granted — no access request needed.
        let (devices, _) = try client.callTool("list_devices")
        let entry = devices["devices"].arr?.first { $0["id"].str == stack.deviceId }
        XCTAssertEqual(entry?["granted"].boolValue, true)

        let (result, isError) = try client.callTool("run_command", [
            "device": .string(stack.deviceId),
            "argv": ["/bin/echo", "spawned"],
        ])
        XCTAssertFalse(isError, "spawned agent should operate: \(result.jsonString())")
        XCTAssertEqual(result["output"].str, "spawned\n")
        client.close()
    }
}
