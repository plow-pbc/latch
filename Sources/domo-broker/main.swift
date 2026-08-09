import Foundation
import DomoProtocol
import DomoBrokerCore

// domo-broker: the local rendezvous daemon.
//   domo-broker --home <dir> [--agent-socket p] [--device-socket p]
//   domo-broker create-agent --home <dir> --name <display>   (prints token JSON)

func parseArgs(_ args: [String]) -> [String: String] {
    var result: [String: String] = [:]
    var i = 0
    while i < args.count {
        if args[i].hasPrefix("--"), i + 1 < args.count {
            result[String(args[i].dropFirst(2))] = args[i + 1]
            i += 2
        } else {
            i += 1
        }
    }
    return result
}

let arguments = Array(CommandLine.arguments.dropFirst())
let defaultHome = DomoPaths.defaultHome

if arguments.first == "create-agent" {
    let options = parseArgs(Array(arguments.dropFirst()))
    let home = URL(fileURLWithPath: options["home"] ?? defaultHome)
    let store = BrokerStore(home: home)
    let record = store.createAgent(display: options["name"] ?? "Agent")
    let output: JSONValue = [
        "token": .string(record.token),
        "agent_id": .string(record.agentId),
        "public_key": .string(record.publicKeyBase64),
    ]
    print(output.jsonString())
    exit(0)
}

let options = parseArgs(arguments)
let home = URL(fileURLWithPath: options["home"] ?? defaultHome)
let runDir = home.appendingPathComponent("run")
try? FileManager.default.createDirectory(at: runDir, withIntermediateDirectories: true)
try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: runDir.path)

let agentSocket = options["agent-socket"] ?? runDir.appendingPathComponent("agent.sock").path
let deviceSocket = options["device-socket"] ?? runDir.appendingPathComponent("device.sock").path

do {
    let broker = try Broker(home: home, agentSocket: agentSocket, deviceSocket: deviceSocket)
    // Advertise the sibling domo-mcp shim for spawn_agent MCP configs.
    let selfDir = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        .deletingLastPathComponent()
    let shim = selfDir.appendingPathComponent("domo-mcp")
    if FileManager.default.isExecutableFile(atPath: shim.path) {
        broker.mcpShimPath = shim.path
    }
    broker.start()
    FileHandle.standardOutput.write(Data("domo-broker listening agent=\(agentSocket) device=\(deviceSocket)\n".utf8))
    dispatchMain()
} catch {
    FileHandle.standardError.write(Data("domo-broker failed to start: \(error)\n".utf8))
    exit(1)
}
