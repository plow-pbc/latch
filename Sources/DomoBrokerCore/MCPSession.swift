import Foundation
import DomoProtocol
import DomoTransport

/// One authenticated agent connection speaking MCP (JSON-RPC 2.0, one message
/// per line). Translates tool calls into signed intents routed to devices.
final class MCPSession {
    private unowned let broker: Broker
    private let conn: Connection
    private let agentToken: String
    private let sessionId = UUID().uuidString
    private let queue = DispatchQueue(label: "domo.mcp.session", attributes: .concurrent)

    init(broker: Broker, connection: Connection, agentToken: String) {
        self.broker = broker
        self.conn = connection
        self.agentToken = agentToken
    }

    private var agent: AgentRecord? { broker.store.agent(token: agentToken) }

    func handleLine(_ line: Data) {
        guard let message = try? JSONValue.parse(line) else { return }
        let id = message["id"]
        guard let method = message["method"].str else { return }
        if id.isNull { return } // notifications (e.g. notifications/initialized)
        queue.async { [weak self] in
            guard let self else { return }
            let result = self.dispatch(method: method, params: message["params"])
            switch result {
            case .success(let value):
                self.send(["jsonrpc": "2.0", "id": id, "result": value])
            case .failure(let error):
                self.send(["jsonrpc": "2.0", "id": id,
                           "error": ["code": .number(-32000), "message": .string(error.message)]])
            }
        }
    }

    private func send(_ message: JSONValue) {
        conn.sendLine(message.encoded())
    }

    private func dispatch(method: String, params: JSONValue) -> Result<JSONValue, RPCError> {
        switch method {
        case "initialize":
            let requested = params["protocolVersion"].str ?? "2024-11-05"
            return .success([
                "protocolVersion": .string(requested),
                "capabilities": ["tools": [:]],
                "serverInfo": ["name": "domo-broker", "version": "0.1.0"],
            ])
        case "ping":
            return .success([:])
        case "tools/list":
            return .success(["tools": MCPTools.definitions])
        case "tools/call":
            guard let name = params["name"].str else {
                return .failure(RPCError("missing tool name"))
            }
            return callTool(name: name, args: params["arguments"])
        default:
            return .failure(RPCError("method not supported: \(method)"))
        }
    }

    // MARK: - Tool dispatch

    private func callTool(name: String, args: JSONValue) -> Result<JSONValue, RPCError> {
        do {
            let result = try runTool(name: name, args: args)
            return .success(["content": [["type": "text", "text": .string(result.jsonString())]],
                             "isError": false])
        } catch let error as ToolError {
            return .success(["content": [["type": "text", "text": .string(error.message)]],
                             "isError": true])
        } catch {
            return .success(["content": [["type": "text", "text": .string("\(error)")]],
                             "isError": true])
        }
    }

    struct ToolError: Error {
        let message: String
        init(_ message: String) { self.message = message }
    }

    private func runTool(name: String, args: JSONValue) throws -> JSONValue {
        switch name {
        case "list_devices": return try listDevices()
        case "request_device_access": return try requestAccess(args)
        case "read_file": return try readFile(args)
        case "write_file": return try writeFile(args)
        case "run_command": return try runCommand(args)
        case "get_output": return try getOutput(args)
        case "list_device_tools": return try listDeviceTools(args)
        case "use_tool": return try useTool(args)
        default: throw ToolError("unknown tool: \(name)")
        }
    }

    private func requireAgent() throws -> AgentRecord {
        guard let agent else { throw ToolError("agent identity revoked") }
        return agent
    }

    private func requireGrantedLink(_ args: JSONValue) throws -> (AgentRecord, String, Broker.DeviceLink) {
        let agent = try requireAgent()
        guard let deviceId = args["device"].str else { throw ToolError("missing 'device'") }
        guard agent.grantedDevices.contains(deviceId) else {
            throw ToolError("no grant for device \(deviceId); call request_device_access first")
        }
        guard let link = broker.deviceLink(deviceId) else {
            throw ToolError("device \(deviceId) is offline")
        }
        return (agent, deviceId, link)
    }

    private func listDevices() throws -> JSONValue {
        let agent = try requireAgent()
        let online = broker.onlineDeviceIds()
        return ["devices": .array(broker.store.allDevices().map { device in
            [
                "id": .string(device.deviceId),
                "name": .string(device.name),
                "online": .bool(online.contains(device.deviceId)),
                "granted": .bool(agent.grantedDevices.contains(device.deviceId)),
            ]
        })]
    }

    private func requestAccess(_ args: JSONValue) throws -> JSONValue {
        let agent = try requireAgent()
        guard let deviceId = args["device"].str else { throw ToolError("missing 'device'") }
        guard let goals = args["goals"].str, !goals.isEmpty else {
            throw ToolError("missing 'goals' — state what you intend to do on this Mac")
        }
        guard let link = broker.deviceLink(deviceId) else {
            throw ToolError("device \(deviceId) is offline")
        }
        if agent.grantedDevices.contains(deviceId) {
            return ["status": "granted", "note": "already granted"]
        }
        // Approval can take as long as a human takes; generous timeout.
        let response = try link.rpc.call("access_request", [
            "agent": [
                "id": .string(agent.agentId),
                "display": .string(agent.display),
                "publicKey": .string(agent.publicKeyBase64),
            ],
            "goals": .string(goals),
        ], timeout: 600)
        let approved = response["approved"].boolValue ?? false
        if approved {
            broker.store.grantDevice(token: agentToken, deviceId: deviceId)
            broker.store.recordSessionGoals(token: agentToken, goals: goals)
        }
        return ["status": .string(approved ? "granted" : "denied")]
    }

    // MARK: - Intent construction

    private func makeIntent(agent: AgentRecord, deviceId: String, goal: String?,
                            request: String, capabilities: [Capability]) throws -> Intent {
        var intent = Intent(agentId: agent.agentId, agentDisplay: agent.display,
                            agentPublicKey: agent.publicKeyBase64, deviceId: deviceId,
                            goal: goal, planContext: agent.sessionGoals,
                            request: request, capabilities: capabilities,
                            sessionId: sessionId)
        try intent.sign(with: try agent.keyPair())
        return intent
    }

    private func sendIntent(_ intent: Intent, payload: JSONValue,
                            to link: Broker.DeviceLink, timeout: TimeInterval = 630) throws -> JSONValue {
        let response = try link.rpc.call("intent", [
            "intent": JSONValue.from(intent),
            "payload": payload,
        ], timeout: timeout)
        switch response["status"].str {
        case "denied": throw ToolError("the device owner denied this request")
        case "rejected": throw ToolError("device rejected intent: \(response["reason"].str ?? "unknown")")
        case "error": throw ToolError(response["error"].str ?? "device error")
        default: return response
        }
    }

    // MARK: - Tools

    private func readFile(_ args: JSONValue) throws -> JSONValue {
        let (agent, deviceId, link) = try requireGrantedLink(args)
        guard let path = args["path"].str else { throw ToolError("missing 'path'") }
        let intent = try makeIntent(agent: agent, deviceId: deviceId, goal: args["goal"].str,
                                    request: "read file: \(path)",
                                    capabilities: [Capability(kind: .fsRead, paths: [path])])
        let response = try sendIntent(intent, payload: .null, to: link)
        guard let base64 = response["content_base64"].str, let data = Data(base64Encoded: base64) else {
            throw ToolError("device returned no content")
        }
        if let text = String(data: data, encoding: .utf8) {
            return ["path": .string(path), "content": .string(text)]
        }
        return ["path": .string(path), "content_base64": .string(base64)]
    }

    private func writeFile(_ args: JSONValue) throws -> JSONValue {
        let (agent, deviceId, link) = try requireGrantedLink(args)
        guard let path = args["path"].str else { throw ToolError("missing 'path'") }
        guard let content = args["content"].str else { throw ToolError("missing 'content'") }
        let data = Data(content.utf8)
        let intent = try makeIntent(agent: agent, deviceId: deviceId, goal: args["goal"].str,
                                    request: "write file: \(path) (\(data.count) bytes)",
                                    capabilities: [Capability(kind: .fsWrite, paths: [path])])
        let response = try sendIntent(intent, payload: [
            "content_base64": .string(data.base64EncodedString()),
        ], to: link)
        return ["path": .string(path), "bytes": response["bytes"]]
    }

    private func runCommand(_ args: JSONValue) throws -> JSONValue {
        let (agent, deviceId, link) = try requireGrantedLink(args)
        guard let argvValues = args["argv"].arr, !argvValues.isEmpty else {
            throw ToolError("missing 'argv'")
        }
        let argv = argvValues.compactMap { $0.str }
        guard argv.count == argvValues.count else { throw ToolError("argv must be strings") }
        let readPaths = (args["read_paths"].arr ?? []).compactMap { $0.str }
        let writePaths = (args["write_paths"].arr ?? []).compactMap { $0.str }
        let network = args["network"].boolValue ?? false
        let waitMs = args["wait_ms"].int ?? 10000

        var capabilities: [Capability] = [
            Capability(kind: .processExec, argv: argv, cwd: args["cwd"].str),
            Capability(kind: .network, allowed: network),
        ]
        if !readPaths.isEmpty { capabilities.append(Capability(kind: .fsRead, paths: readPaths)) }
        if !writePaths.isEmpty { capabilities.append(Capability(kind: .fsWrite, paths: writePaths)) }

        let intent = try makeIntent(agent: agent, deviceId: deviceId, goal: args["goal"].str,
                                    request: "run: \(argv.joined(separator: " "))",
                                    capabilities: capabilities)
        let response = try sendIntent(intent, payload: ["wait_ms": .number(Double(waitMs))],
                                      to: link, timeout: TimeInterval(waitMs) / 1000.0 + 630)
        return response
    }

    private func getOutput(_ args: JSONValue) throws -> JSONValue {
        let (_, _, link) = try requireGrantedLink(args)
        guard let handle = args["handle"].str else { throw ToolError("missing 'handle'") }
        // Output retrieval is bound to an already-approved run; no new intent.
        return try link.rpc.call("get_output", [
            "handle": .string(handle),
            "since": .number(Double(args["since"].int ?? 0)),
        ], timeout: 30)
    }

    private func listDeviceTools(_ args: JSONValue) throws -> JSONValue {
        let (_, _, link) = try requireGrantedLink(args)
        return ["tools": link.blessedTools]
    }

    private func useTool(_ args: JSONValue) throws -> JSONValue {
        let (agent, deviceId, link) = try requireGrantedLink(args)
        guard let tool = args["tool"].str else { throw ToolError("missing 'tool'") }
        let intent = try makeIntent(agent: agent, deviceId: deviceId, goal: args["goal"].str,
                                    request: "use blessed tool: \(tool)",
                                    capabilities: [Capability(kind: .tool, tool: tool)])
        let response = try sendIntent(intent, payload: ["args": args["args"]], to: link)
        return ["result": response["result"]]
    }
}

/// Static MCP tool definitions (DESIGN.md §3).
enum MCPTools {
    static let definitions: JSONValue = [
        [
            "name": "list_devices",
            "description": "List the Macs visible to this agent: id, name, online status, and whether you already hold an access grant.",
            "inputSchema": ["type": "object", "properties": [:]],
        ],
        [
            "name": "request_device_access",
            "description": "Ask a Mac's owner for permission to use it. State your goals honestly — the owner sees them. Returns granted or denied.",
            "inputSchema": ["type": "object", "required": ["device", "goals"], "properties": [
                "device": ["type": "string", "description": "Device id from list_devices"],
                "goals": ["type": "string", "description": "What you intend to do on this Mac and why"],
            ]],
        ],
        [
            "name": "read_file",
            "description": "Read a file on a granted Mac. The owner may be asked to approve.",
            "inputSchema": ["type": "object", "required": ["device", "path"], "properties": [
                "device": ["type": "string"],
                "path": ["type": "string", "description": "Absolute path (~ allowed)"],
                "goal": ["type": "string", "description": "Why you need this file (shown to the approver)"],
            ]],
        ],
        [
            "name": "write_file",
            "description": "Write a file on a granted Mac. The owner may be asked to approve.",
            "inputSchema": ["type": "object", "required": ["device", "path", "content"], "properties": [
                "device": ["type": "string"],
                "path": ["type": "string"],
                "content": ["type": "string"],
                "goal": ["type": "string", "description": "Why (shown to the approver)"],
            ]],
        ],
        [
            "name": "run_command",
            "description": "Run a CLI command on a granted Mac inside a sandbox limited to the paths you declare here. Declare every path you need up front; undeclared paths are blocked by the sandbox. Waits up to wait_ms; if still running you get a handle for get_output.",
            "inputSchema": ["type": "object", "required": ["device", "argv"], "properties": [
                "device": ["type": "string"],
                "argv": ["type": "array", "items": ["type": "string"],
                         "description": "Command and arguments, e.g. [\"ls\", \"-la\", \"/tmp\"]"],
                "cwd": ["type": "string", "description": "Working directory (readable by the sandbox)"],
                "read_paths": ["type": "array", "items": ["type": "string"],
                               "description": "Directories/files the command may read"],
                "write_paths": ["type": "array", "items": ["type": "string"],
                                "description": "Directories/files the command may write"],
                "network": ["type": "boolean", "description": "Whether the command needs network access (default false)"],
                "wait_ms": ["type": "integer", "description": "How long to wait for completion before returning a handle (default 10000)"],
                "goal": ["type": "string", "description": "Why (shown to the approver)"],
            ]],
        ],
        [
            "name": "get_output",
            "description": "Fetch incremental output of a still-running command. Pass 'since' = the output_length you last saw.",
            "inputSchema": ["type": "object", "required": ["device", "handle"], "properties": [
                "device": ["type": "string"],
                "handle": ["type": "string"],
                "since": ["type": "integer"],
            ]],
        ],
        [
            "name": "list_device_tools",
            "description": "List the blessed tools available on a specific Mac, with their JSON input schemas. Different Macs have different tools.",
            "inputSchema": ["type": "object", "required": ["device"], "properties": [
                "device": ["type": "string"],
            ]],
        ],
        [
            "name": "use_tool",
            "description": "Invoke a blessed tool on a granted Mac (discover them with list_device_tools).",
            "inputSchema": ["type": "object", "required": ["device", "tool"], "properties": [
                "device": ["type": "string"],
                "tool": ["type": "string"],
                "args": ["type": "object"],
                "goal": ["type": "string", "description": "Why (shown to the approver)"],
            ]],
        ],
    ]
}
