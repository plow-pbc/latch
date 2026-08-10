import Foundation
import DomoProtocol
import DomoTransport

// domo-mcp: stdio↔broker shim so MCP clients (Claude Code) can talk to the
// broker. Resolves how to connect, sends the auth line, then pipes both ways.
//
// The easy path — ONE value that bundles URL + pin + token:
//   claude mcp add domo -e DOMO_CONNECTION='domo1.…' -- <path>/domo-mcp
// or drop it in ~/.domo/agent.json as {"connection":"domo1.…"} and just run the
// shim. `domo-broker issue-agent` prints this string.
//
// The explicit path (still supported): DOMO_AGENT_TOKEN (required) plus optional
// DOMO_AGENT_SOCKET (a socket path or ws(s):// URL; defaults to the local broker)
// and DOMO_BROKER_PIN for wss.

let env = ProcessInfo.processInfo.environment

/// ~/.domo/agent.json → {"connection":"domo1.…"} (a no-env-vars fallback).
func agentFileConnection() -> String? {
    let url = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".domo/agent.json")
    guard let data = try? Data(contentsOf: url),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return obj["connection"] as? String
}

// Resolve endpoint / token / pin. A connection string (env or file) wins; the
// individual env vars fill anything it doesn't carry.
var endpoint: String
var token: String?
var pin: String?
if let cs = env["DOMO_CONNECTION"] ?? agentFileConnection(), let conn = DomoConnection.parse(cs) {
    endpoint = conn.url
    token = conn.token
    pin = conn.pin
} else {
    endpoint = env["DOMO_AGENT_SOCKET"] ?? DomoPaths.agentSocket()
    pin = env["DOMO_BROKER_PIN"]
}
token = token ?? env["DOMO_AGENT_TOKEN"]

guard let token else {
    FileHandle.standardError.write(Data("domo-mcp: set DOMO_CONNECTION (from `domo-broker issue-agent`) or DOMO_AGENT_TOKEN.\n".utf8))
    exit(2)
}

func dialBroker() throws -> Connection {
    if endpoint.hasPrefix("ws://") || endpoint.hasPrefix("wss://"), let url = URL(string: endpoint) {
        let trust = pin.map { SPKIPinningEvaluator(pins: [SPKIPin(sha256Base64: $0)]) }
        return try WebSocketDialer(url: url, trust: trust).connect()
    }
    return try SocketClient.connect(path: endpoint)
}

do {
    let conn = try dialBroker()
    let authed = DispatchSemaphore(value: 0)
    var authOk = false

    conn.onLine = { line in
        if !authOk {
            let message = try? JSONValue.parse(line)
            if message?["type"].str == "domo-auth-ok" {
                authOk = true
                authed.signal()
                return
            }
            FileHandle.standardError.write(Data("domo-mcp: broker rejected token\n".utf8))
            exit(3)
        }
        var out = line
        out.append(0x0A)
        FileHandle.standardOutput.write(out)
    }
    conn.onClose = { exit(0) }
    conn.startReading()

    conn.sendLine(JSONValue.object(["type": "domo-auth", "token": .string(token)]).encoded())
    if authed.wait(timeout: .now() + 10) != .success {
        FileHandle.standardError.write(Data("domo-mcp: auth timeout\n".utf8))
        exit(3)
    }

    // Pipe stdin lines to the socket until EOF.
    let stdinHandle = FileHandle.standardInput
    var buffer = Data()
    while true {
        let chunk = stdinHandle.availableData
        if chunk.isEmpty { break }
        buffer.append(chunk)
        while let newlineIndex = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<newlineIndex)
            buffer.removeSubrange(buffer.startIndex...newlineIndex)
            if !line.isEmpty { conn.sendLine(line) }
        }
    }
    conn.close()
} catch {
    FileHandle.standardError.write(Data("domo-mcp: \(error)\n".utf8))
    exit(1)
}
