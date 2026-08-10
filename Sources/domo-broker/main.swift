import Foundation
import Security
import DomoProtocol
import DomoTransport
import DomoBrokerCore

// domo-broker: the rendezvous daemon + provisioner CLI.
//
//   domo-broker --home <dir>                                        (Unix, v1 local)
//   domo-broker --home <dir> --agent-listen wss://0.0.0.0:8443/ \   (networked/hosted)
//               --device-listen wss://0.0.0.0:8444/ --public-host broker.example \
//               --require-enrollment
//       ↑ with no --tls-p12, a self-signed cert is generated on first run and
//         the device connection string (URL + pin) is printed.
//   domo-broker --config broker.json                               (all flags from a file)
//
//   domo-broker connect-string --home <dir>          → the Mac's connection string
//   domo-broker issue-agent --home <dir> --name X    → a ready agent connection string
//   domo-broker enroll-device / revoke-agent / create-agent        (provisioning)

func parseArgs(_ args: [String]) -> [String: String] {
    var result: [String: String] = [:]
    var i = 0
    while i < args.count {
        if args[i].hasPrefix("--"), i + 1 < args.count, !args[i + 1].hasPrefix("--") {
            result[String(args[i].dropFirst(2))] = args[i + 1]
            i += 2
        } else if args[i].hasPrefix("--") {
            // A bare flag (e.g. --require-enrollment).
            result[String(args[i].dropFirst(2))] = ""
            i += 1
        } else {
            i += 1
        }
    }
    return result
}

/// Overlay a JSON config file onto parsed CLI options — CLI wins. Booleans become
/// presence (true → "", the bare-flag convention); everything else stringifies.
func withConfig(_ options: [String: String]) -> [String: String] {
    guard let path = options["config"],
          let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return options }
    var merged = options
    for (key, value) in obj where merged[key] == nil {
        switch value {
        case let b as Bool: if b { merged[key] = "" }
        case let s as String: merged[key] = s
        case let n as NSNumber: merged[key] = n.stringValue
        default: break
        }
    }
    return merged
}

let arguments = Array(CommandLine.arguments.dropFirst())
let defaultHome = DomoPaths.defaultHome

// MARK: - Cert / endpoint helpers (hosting)

struct BrokerEndpoints: Codable {
    var agentURL: String
    var deviceURL: String
    var pin: String?
    var authenticate: Bool
}

func endpointsURL(home: URL) -> URL { home.appendingPathComponent("broker/endpoints.json") }

func loadEndpoints(home: URL) -> BrokerEndpoints? {
    guard let data = try? Data(contentsOf: endpointsURL(home: home)) else { return nil }
    return try? JSONDecoder().decode(BrokerEndpoints.self, from: data)
}

func saveEndpoints(_ e: BrokerEndpoints, home: URL) {
    let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    try? FileManager.default.createDirectory(at: home.appendingPathComponent("broker"),
                                             withIntermediateDirectories: true)
    try? enc.encode(e).write(to: endpointsURL(home: home))
}

@discardableResult
func runOpenSSL(_ args: [String]) -> Bool {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = ["openssl"] + args
    p.standardError = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    do { try p.run(); p.waitUntilExit(); return p.terminationStatus == 0 } catch { return false }
}

/// Ensure a self-signed broker identity exists under `home/tls`, generating one
/// on first run. Returns (p12 path, password). The intended posture is
/// self-signed + pinning — no public CA (runbook Phase 2/6).
func ensureBrokerCert(home: URL, publicHost: String) -> (path: String, password: String)? {
    let tlsDir = home.appendingPathComponent("tls")
    let p12 = tlsDir.appendingPathComponent("broker-identity.p12")
    let passFile = tlsDir.appendingPathComponent("p12.pass")
    if FileManager.default.fileExists(atPath: p12.path),
       let pw = try? String(contentsOf: passFile, encoding: .utf8) {
        return (p12.path, pw.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    try? FileManager.default.createDirectory(at: tlsDir, withIntermediateDirectories: true)
    try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: tlsDir.path)
    let key = tlsDir.appendingPathComponent("broker-key.pem")
    let cert = tlsDir.appendingPathComponent("broker-cert.pem")
    let password = UUID().uuidString
    guard runOpenSSL(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key.path]),
          runOpenSSL(["req", "-x509", "-new", "-key", key.path, "-out", cert.path,
                      "-days", "3650", "-subj", "/CN=\(publicHost)", "-sha256"]),
          runOpenSSL(["pkcs12", "-export", "-inkey", key.path, "-in", cert.path,
                      "-out", p12.path, "-passout", "pass:\(password)", "-name", "domo"])
    else { return nil }
    try? password.write(to: passFile, atomically: true, encoding: .utf8)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: passFile.path)
    return (p12.path, password)
}

/// SPKI pin of a loaded identity's certificate, reusing the tested extractor.
func spkiPin(of identity: SecIdentity) -> String? {
    var cert: SecCertificate?
    guard SecIdentityCopyCertificate(identity, &cert) == errSecSuccess, let cert else { return nil }
    let der = SecCertificateCopyData(cert) as Data
    return SPKIPin(derCertificate: der)?.sha256Base64
}

// MARK: - Subcommands

if arguments.first == "create-agent" {
    let options = withConfig(parseArgs(Array(arguments.dropFirst())))
    let home = URL(fileURLWithPath: options["home"] ?? defaultHome)
    let record = BrokerStore(home: home).createAgent(display: options["name"] ?? "Agent")
    print(JSONValue.object([
        "token": .string(record.token), "agent_id": .string(record.agentId),
        "public_key": .string(record.publicKeyBase64),
    ]).jsonString())
    exit(0)
}

if arguments.first == "issue-agent" {
    // One command → a ready agent connection string (URL + pin + token). This is
    // the artifact a person pastes; no raw token juggling.
    let options = withConfig(parseArgs(Array(arguments.dropFirst())))
    let home = URL(fileURLWithPath: options["home"] ?? defaultHome)
    guard let ep = loadEndpoints(home: home) else {
        FileHandle.standardError.write(Data("issue-agent: no broker endpoints found — start the broker once so it records its address.\n".utf8))
        exit(2)
    }
    let name = options["name"] ?? "Agent"
    let record = BrokerStore(home: home).createAgent(display: name)
    let conn = DomoConnection(url: ep.agentURL, pin: ep.pin, token: record.token, name: name)
    // Resolve the sibling domo-mcp shim so the printed command is runnable as-is.
    let selfDir = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        .deletingLastPathComponent()
    let shim = selfDir.appendingPathComponent("domo-mcp").path
    // An ephemeral, self-contained MCP config passed inline — nothing is added to
    // Claude's persistent config.
    let mcpConfig: JSONValue = ["mcpServers": ["domo": [
        "type": "stdio",
        "command": .string(shim),
        "env": ["DOMO_CONNECTION": .string(conn.compactString())],
    ]]]
    let command = "claude --strict-mcp-config --mcp-config '\(mcpConfig.jsonString())' --allowedTools mcp__domo"
    print("Agent \"\(name)\" (\(record.agentId)) — run an ephemeral Claude session (nothing persists):\n")
    print("  \(command)\n")
    print("Add a prompt if you like — it MUST come first: claude \"do X\" --strict-mcp-config …\n")
    print("Raw connection string (if you need it elsewhere): \(conn.compactString())")
    exit(0)
}

if arguments.first == "connect-string" {
    // The Mac's connection string (URL + pin). Safe to show / QR — no secret.
    let options = withConfig(parseArgs(Array(arguments.dropFirst())))
    let home = URL(fileURLWithPath: options["home"] ?? defaultHome)
    guard let ep = loadEndpoints(home: home) else {
        FileHandle.standardError.write(Data("connect-string: no broker endpoints found — start the broker once first.\n".utf8))
        exit(2)
    }
    let conn = DomoConnection(url: ep.deviceURL, pin: ep.pin, name: "Domo broker", authenticate: ep.authenticate)
    print("Device connection string (paste into the Domo app):\n")
    print("  \(conn.compactString())\n")
    print("Or open on the Mac:  \(conn.deepLink())")
    exit(0)
}

if arguments.first == "enroll-device" {
    let options = withConfig(parseArgs(Array(arguments.dropFirst())))
    let home = URL(fileURLWithPath: options["home"] ?? defaultHome)
    guard let pubkey = options["pubkey"] else {
        FileHandle.standardError.write(Data("enroll-device: --pubkey <base64> required (see `domo-device identity`)\n".utf8))
        exit(2)
    }
    let deviceId = options["device-id"] ?? KeyPair.fingerprint(ofPublicKeyBase64: pubkey)
    let record = BrokerStore(home: home).enrollDevice(deviceId: deviceId, name: options["name"] ?? "Mac",
                                                      publicKeyBase64: pubkey)
    print(JSONValue.object(["device_id": .string(record.deviceId), "name": .string(record.name)]).jsonString())
    exit(0)
}

if arguments.first == "pending" {
    // List devices awaiting pairing approval (runbook Phase 3 pairing).
    let options = withConfig(parseArgs(Array(arguments.dropFirst())))
    let home = URL(fileURLWithPath: options["home"] ?? defaultHome)
    let pending = BrokerStore(home: home).pendingPairings()
    if pending.isEmpty { print("No pending pairings."); exit(0) }
    print("Pending pairings — approve the one whose code matches the Mac's screen:\n")
    for p in pending {
        print("  code \(p.code)   \(p.name) (\(p.deviceId))")
    }
    print("\n  domo-broker approve-pairing --home \(home.path) --code <code>")
    exit(0)
}

if arguments.first == "approve-pairing" {
    let options = withConfig(parseArgs(Array(arguments.dropFirst())))
    let home = URL(fileURLWithPath: options["home"] ?? defaultHome)
    guard let code = options["code"] else {
        FileHandle.standardError.write(Data("approve-pairing: --code required (see `domo-broker pending`)\n".utf8))
        exit(2)
    }
    guard let record = BrokerStore(home: home).approvePairing(code: code) else {
        FileHandle.standardError.write(Data("approve-pairing: no pending pairing with code \(code)\n".utf8))
        exit(1)
    }
    print(JSONValue.object(["enrolled": .string(record.deviceId), "name": .string(record.name)]).jsonString())
    exit(0)
}

if arguments.first == "revoke-agent" {
    let options = withConfig(parseArgs(Array(arguments.dropFirst())))
    let home = URL(fileURLWithPath: options["home"] ?? defaultHome)
    guard let agentId = options["agent-id"] else {
        FileHandle.standardError.write(Data("revoke-agent: --agent-id required\n".utf8))
        exit(2)
    }
    BrokerStore(home: home).revokeAgent(agentId: agentId)
    print(JSONValue.object(["revoked": .string(agentId)]).jsonString())
    exit(0)
}

// MARK: - Daemon

let options = withConfig(parseArgs(arguments))
let home = URL(fileURLWithPath: options["home"] ?? defaultHome)
let runDir = home.appendingPathComponent("run")
try? FileManager.default.createDirectory(at: runDir, withIntermediateDirectories: true)
try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: runDir.path)

let agentSocket = options["agent-socket"] ?? runDir.appendingPathComponent("agent.sock").path
let deviceSocket = options["device-socket"] ?? runDir.appendingPathComponent("device.sock").path

func listenPort(_ urlString: String) -> UInt16? {
    guard let url = URL(string: urlString), let port = url.port else { return nil }
    return UInt16(port)
}

do {
    let broker: Broker
    var startupConnectString: String?

    if let agentListen = options["agent-listen"], let deviceListen = options["device-listen"] {
        guard let agentPort = listenPort(agentListen), let devicePort = listenPort(deviceListen) else {
            FileHandle.standardError.write(Data("domo-broker: --agent-listen/--device-listen must be ws(s)://host:PORT\n".utf8))
            exit(2)
        }
        let wantsTLS = agentListen.hasPrefix("wss://") || deviceListen.hasPrefix("wss://") || options["tls-p12"] != nil
        let publicHost = options["public-host"] ?? "127.0.0.1"
        let requireEnrollment = options["require-enrollment"] != nil

        var identity: SecIdentity?
        if wantsTLS {
            // Explicit cert, or auto-generate a self-signed one on first run.
            let p12: String, pass: String
            if let explicit = options["tls-p12"] {
                p12 = explicit; pass = options["tls-password"] ?? ""
            } else if let generated = ensureBrokerCert(home: home, publicHost: publicHost) {
                p12 = generated.path; pass = generated.password
            } else {
                FileHandle.standardError.write(Data("domo-broker: could not create/find a TLS cert (is `openssl` on PATH?)\n".utf8))
                exit(2)
            }
            guard let loaded = TLSIdentity.load(p12Path: p12, password: pass) else {
                FileHandle.standardError.write(Data("domo-broker: could not load TLS identity at \(p12)\n".utf8))
                exit(2)
            }
            identity = loaded
        }

        let scheme = identity != nil ? "wss" : "ws"
        let agentURL = "\(scheme)://\(publicHost):\(agentPort)/"
        let deviceURL = "\(scheme)://\(publicHost):\(devicePort)/"
        let pin = identity.flatMap(spkiPin(of:))

        let agentListener = try WebSocketListener(port: agentPort, identity: identity)
        let deviceListener = try WebSocketListener(port: devicePort, identity: identity)
        broker = try Broker(home: home, agentListener: agentListener, deviceListener: deviceListener,
                            agentEndpoint: agentURL, requireEnrollment: requireEnrollment)

        saveEndpoints(BrokerEndpoints(agentURL: agentURL, deviceURL: deviceURL,
                                      pin: pin, authenticate: requireEnrollment), home: home)
        let deviceConn = DomoConnection(url: deviceURL, pin: pin, name: "Domo broker",
                                        authenticate: requireEnrollment)
        startupConnectString = deviceConn.compactString()
    } else {
        broker = try Broker(home: home, agentSocket: agentSocket, deviceSocket: deviceSocket)
    }

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
    if let cs = startupConnectString {
        FileHandle.standardOutput.write(Data("""

        Device connection string (paste into the Domo app):
          \(cs)
        Issue an agent:  domo-broker issue-agent --home \(home.path) --name <name>

        """.utf8))
    }
    dispatchMain()
} catch {
    FileHandle.standardError.write(Data("domo-broker failed to start: \(error)\n".utf8))
    exit(1)
}
