import XCTest
import Foundation
import DomoProtocol
import DomoTransport

/// Boots a real broker process + real headless device process in a throwaway
/// DOMO_HOME, and provides an MCP client speaking JSON-RPC over the agent
/// socket — the full stack, no UI, no human (DESIGN.md §10).
final class TestStack {
    let home: URL
    let agentSocket: String
    let deviceSocket: String
    private var brokerProcess: Process?
    private var deviceProcess: Process?
    private(set) var deviceId: String = ""

    static var productsDirectory: URL {
        for bundle in Bundle.allBundles where bundle.bundlePath.hasSuffix(".xctest") {
            return bundle.bundleURL.deletingLastPathComponent()
        }
        fatalError("cannot locate build products directory")
    }

    init() {
        home = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("domo-e2e-\(UUID().uuidString.prefix(8))")
        try! FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        agentSocket = home.appendingPathComponent("a.sock").path
        deviceSocket = home.appendingPathComponent("d.sock").path
    }

    func createAgent(name: String) throws -> (token: String, agentId: String) {
        let process = Process()
        process.executableURL = Self.productsDirectory.appendingPathComponent("domo-broker")
        process.arguments = ["create-agent", "--home", home.path, "--name", name]
        let pipe = Pipe()
        process.standardOutput = pipe
        try process.run()
        process.waitUntilExit()
        let output = pipe.fileHandleForReading.readDataToEndOfFile()
        let parsed = try JSONValue.parse(output)
        return (parsed["token"].str!, parsed["agent_id"].str!)
    }

    func startBroker() throws {
        let process = Process()
        process.executableURL = Self.productsDirectory.appendingPathComponent("domo-broker")
        process.arguments = ["--home", home.path,
                             "--agent-socket", agentSocket,
                             "--device-socket", deviceSocket]
        process.standardOutput = FileHandle.nullDevice
        try process.run()
        brokerProcess = process
        try waitForSocket(agentSocket)
        try waitForSocket(deviceSocket)
    }

    /// If `spawnGoal` is set, the device drives the Mac-initiated spawn flow at
    /// startup and writes the spawned agent's token JSON to `spawnTokenOut`.
    func startDevice(policy: [String: JSONValue] = ["access": "allow", "intent": "allow_once"],
                     name: String = "TestMac",
                     spawnGoal: String? = nil,
                     spawnTokenOut: String? = nil) throws {
        let policyURL = home.appendingPathComponent("policy-\(UUID().uuidString.prefix(6)).json")
        try JSONValue.object(policy).encoded().write(to: policyURL)
        let process = Process()
        process.executableURL = Self.productsDirectory.appendingPathComponent("domo-device")
        var args = ["--home", home.appendingPathComponent("devhome").path,
                    "--broker", deviceSocket,
                    "--name", name,
                    "--policy", policyURL.path]
        if let spawnGoal { args += ["--spawn-goal", spawnGoal] }
        if let spawnTokenOut { args += ["--spawn-token-out", spawnTokenOut] }
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        try process.run()
        deviceProcess = process
        // "domo-device ready id=<id>"
        let deadline = Date().addingTimeInterval(15)
        var buffer = Data()
        while Date() < deadline {
            let chunk = pipe.fileHandleForReading.availableData
            if chunk.isEmpty { Thread.sleep(forTimeInterval: 0.05); continue }
            buffer.append(chunk)
            if let text = String(data: buffer, encoding: .utf8),
               let range = text.range(of: "ready id=") {
                deviceId = String(text[range.upperBound...])
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                return
            }
        }
        throw StackError("device did not become ready")
    }

    var deviceAuditURL: URL {
        home.appendingPathComponent("devhome/device/audit.ndjson")
    }

    func auditEvents() -> [JSONValue] {
        guard let data = try? Data(contentsOf: deviceAuditURL) else { return [] }
        return data.split(separator: 0x0A).compactMap { try? JSONValue.parse(Data($0)) }
    }

    private func waitForSocket(_ path: String) throws {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let conn = try? SocketClient.connect(path: path) {
                conn.close()
                return
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        throw StackError("socket \(path) never appeared")
    }

    func shutdown() {
        deviceProcess?.terminate()
        brokerProcess?.terminate()
        deviceProcess?.waitUntilExit()
        brokerProcess?.waitUntilExit()
        try? FileManager.default.removeItem(at: home)
    }

    struct StackError: Error, CustomStringConvertible {
        let message: String
        init(_ message: String) { self.message = message }
        var description: String { message }
    }
}

/// A real MCP client: authenticates with the agent token, then speaks JSON-RPC
/// over the socket exactly the way the domo-mcp shim + Claude Code would.
final class MCPTestClient {
    private let conn: SocketConnection
    private let lock = NSLock()
    private var pending: [Int: (JSONValue) -> Void] = [:]
    private var nextId = 1
    private let authSemaphore = DispatchSemaphore(value: 0)
    private(set) var authOk = false
    private(set) var authRejected = false

    init(socket: String, token: String) throws {
        conn = try SocketClient.connect(path: socket)
        conn.onLine = { [weak self] line in self?.handleLine(line) }
        conn.startReading()
        conn.sendLine(JSONValue.object(["type": "domo-auth", "token": .string(token)]).encoded())
        _ = authSemaphore.wait(timeout: .now() + 5)
    }

    private func handleLine(_ line: Data) {
        guard let message = try? JSONValue.parse(line) else { return }
        if let type = message["type"].str {
            if type == "domo-auth-ok" { authOk = true }
            if type == "domo-auth-error" { authRejected = true }
            authSemaphore.signal()
            return
        }
        guard let id = message["id"].int else { return }
        lock.lock()
        let completion = pending.removeValue(forKey: id)
        lock.unlock()
        completion?(message)
    }

    func request(_ method: String, _ params: JSONValue = [:],
                 timeout: TimeInterval = 30) throws -> JSONValue {
        lock.lock()
        let id = nextId
        nextId += 1
        lock.unlock()
        let semaphore = DispatchSemaphore(value: 0)
        var response: JSONValue = .null
        lock.lock()
        pending[id] = { message in
            response = message
            semaphore.signal()
        }
        lock.unlock()
        conn.sendLine(JSONValue.object([
            "jsonrpc": "2.0",
            "id": .number(Double(id)),
            "method": .string(method),
            "params": params,
        ]).encoded())
        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            throw TestStack.StackError("timeout on \(method)")
        }
        return response
    }

    func initializeSession() throws {
        let response = try request("initialize", [
            "protocolVersion": "2024-11-05",
            "capabilities": [:],
            "clientInfo": ["name": "e2e", "version": "0"],
        ])
        guard response["result"]["serverInfo"]["name"].str == "domo-broker" else {
            throw TestStack.StackError("bad initialize response: \(response.jsonString())")
        }
    }

    /// Calls a tool and returns (parsed result JSON, isError).
    func callTool(_ name: String, _ args: JSONValue = [:],
                  timeout: TimeInterval = 60) throws -> (JSONValue, Bool) {
        let response = try request("tools/call",
                                   ["name": .string(name), "arguments": args],
                                   timeout: timeout)
        if !response["error"].isNull {
            throw TestStack.StackError("rpc error: \(response["error"].jsonString())")
        }
        let result = response["result"]
        let isError = result["isError"].boolValue ?? false
        let text = result["content"][0]["text"].str ?? ""
        let parsed = (try? JSONValue.parse(text)) ?? .string(text)
        return (parsed, isError)
    }

    func close() {
        conn.close()
    }
}
