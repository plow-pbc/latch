import Foundation
import Security
import DomoProtocol
import DomoTransport
import DomoBrokerCore

// domo-broker: the rendezvous daemon.
//   domo-broker --home <dir> [--agent-socket p] [--device-socket p]     (Unix, v1)
//   domo-broker --home <dir> --agent-listen ws://0.0.0.0:PORT \         (networked)
//               --device-listen ws://0.0.0.0:PORT
//   domo-broker create-agent --home <dir> --name <display>   (prints token JSON)
//
// TLS (wss://) and cert config land in runbook Phase 2 / Phase 6; this CLI wires
// the plain-ws path so the networked transport is drivable end to end.

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

if arguments.first == "enroll-device" {
    // Provisioner action (runbook Phase 3): authorize a device's identity key.
    // The production front-end is the signed-in web session entering the Mac's
    // pairing code; this CLI is the same action for local/hosted operation.
    let options = parseArgs(Array(arguments.dropFirst()))
    let home = URL(fileURLWithPath: options["home"] ?? defaultHome)
    guard let pubkey = options["pubkey"] else {
        FileHandle.standardError.write(Data("enroll-device: --pubkey <base64> required (see `domo-device identity`)\n".utf8))
        exit(2)
    }
    let store = BrokerStore(home: home)
    let deviceId = options["device-id"] ?? KeyPair.fingerprint(ofPublicKeyBase64: pubkey)
    let record = store.enrollDevice(deviceId: deviceId, name: options["name"] ?? "Mac",
                                    publicKeyBase64: pubkey)
    let output: JSONValue = ["device_id": .string(record.deviceId), "name": .string(record.name)]
    print(output.jsonString())
    exit(0)
}

if arguments.first == "revoke-agent" {
    // Provisioner action (runbook Phase 5). If a broker is running against this
    // home it picks up the revocation on its next lookup (reload-on-miss); a
    // running broker instance can also revoke live via Broker.revokeAgent.
    let options = parseArgs(Array(arguments.dropFirst()))
    let home = URL(fileURLWithPath: options["home"] ?? defaultHome)
    guard let agentId = options["agent-id"] else {
        FileHandle.standardError.write(Data("revoke-agent: --agent-id required\n".utf8))
        exit(2)
    }
    BrokerStore(home: home).revokeAgent(agentId: agentId)
    print(JSONValue.object(["revoked": .string(agentId)]).jsonString())
    exit(0)
}

let options = parseArgs(arguments)
let home = URL(fileURLWithPath: options["home"] ?? defaultHome)
let runDir = home.appendingPathComponent("run")
try? FileManager.default.createDirectory(at: runDir, withIntermediateDirectories: true)
try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: runDir.path)

let agentSocket = options["agent-socket"] ?? runDir.appendingPathComponent("agent.sock").path
let deviceSocket = options["device-socket"] ?? runDir.appendingPathComponent("device.sock").path

/// Parse a `ws://host:port` (or `wss://…`) listen URL into a bind port.
func listenPort(_ urlString: String) -> UInt16? {
    guard let url = URL(string: urlString), let port = url.port else { return nil }
    return UInt16(port)
}

do {
    let broker: Broker
    if let agentListen = options["agent-listen"], let deviceListen = options["device-listen"] {
        // Networked transport (runbook Phase 1/6). `--tls-p12` serves wss:// with
        // a (self-signed, pinned) server cert; without it, plain ws (loopback/dev).
        guard let agentPort = listenPort(agentListen), let devicePort = listenPort(deviceListen) else {
            FileHandle.standardError.write(Data("domo-broker: --agent-listen/--device-listen must be ws(s)://host:PORT\n".utf8))
            exit(2)
        }
        var identity: SecIdentity?
        if let p12 = options["tls-p12"] {
            guard let loaded = TLSIdentity.load(p12Path: p12, password: options["tls-password"] ?? "") else {
                FileHandle.standardError.write(Data("domo-broker: could not load --tls-p12 (check path/password)\n".utf8))
                exit(2)
            }
            identity = loaded
        }
        let agentListener = try WebSocketListener(port: agentPort, identity: identity)
        let deviceListener = try WebSocketListener(port: devicePort, identity: identity)
        broker = try Broker(home: home, agentListener: agentListener,
                            deviceListener: deviceListener, agentEndpoint: agentListen,
                            requireEnrollment: options["require-enrollment"] != nil)
    } else {
        broker = try Broker(home: home, agentSocket: agentSocket, deviceSocket: deviceSocket)
    }
    // Advertise the sibling domo-mcp shim for spawn_agent MCP configs.
    let selfDir = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        .deletingLastPathComponent()
    let shim = selfDir.appendingPathComponent("domo-mcp")
    if FileManager.default.isExecutableFile(atPath: shim.path) {
        broker.mcpShimPath = shim.path
    }
    broker.start()
    let agentAddr = options["agent-listen"] ?? agentSocket
    let deviceAddr = options["device-listen"] ?? deviceSocket
    FileHandle.standardOutput.write(Data("domo-broker listening agent=\(agentAddr) device=\(deviceAddr)\n".utf8))
    dispatchMain()
} catch {
    FileHandle.standardError.write(Data("domo-broker failed to start: \(error)\n".utf8))
    exit(1)
}
