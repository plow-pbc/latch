import Foundation
import DomoProtocol

/// A blessed tool: functionality we build specifically for our applications,
/// exposed to agents with a name + description + JSON schema (discovered via
/// list_device_tools). Implementations run in-process as trusted code.
public struct BlessedTool {
    public let name: String
    public let description: String
    public let inputSchema: JSONValue
    public let invoke: (JSONValue) throws -> JSONValue

    public init(name: String, description: String, inputSchema: JSONValue,
                invoke: @escaping (JSONValue) throws -> JSONValue) {
        self.name = name
        self.description = description
        self.inputSchema = inputSchema
        self.invoke = invoke
    }
}

public final class BlessedToolRegistry {
    private var tools: [String: BlessedTool] = [:]

    public init() {}

    public func register(_ tool: BlessedTool) {
        tools[tool.name] = tool
    }

    public func tool(named name: String) -> BlessedTool? {
        tools[name]
    }

    /// Manifest sent to the broker at registration and returned from
    /// list_device_tools.
    public func manifest() -> JSONValue {
        .array(tools.values.sorted { $0.name < $1.name }.map { tool in
            .object([
                "name": .string(tool.name),
                "description": .string(tool.description),
                "inputSchema": tool.inputSchema,
            ])
        })
    }

    /// The built-in demo tool set. Real product tools (browser sessions,
    /// credential-assisted logins, …) register through the same interface.
    public static func standard() -> BlessedToolRegistry {
        let registry = BlessedToolRegistry()
        registry.register(BlessedTool(
            name: "mac_info",
            description: "Basic information about this Mac: hostname, OS version, current user, uptime.",
            inputSchema: ["type": "object", "properties": [:]],
            invoke: { _ in
                let process = ProcessInfo.processInfo
                return [
                    "hostname": .string(process.hostName),
                    "os_version": .string(process.operatingSystemVersionString),
                    "user": .string(NSUserName()),
                    "uptime_seconds": .number(process.systemUptime.rounded()),
                ]
            }))
        return registry
    }
}
