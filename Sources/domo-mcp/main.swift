import Foundation
import DomoProtocol
import DomoTransport

// domo-mcp: stdio↔broker shim so MCP clients (Claude Code) can talk to the
// broker. Sends the auth line from env, then pipes bidirectionally.
//
//   env DOMO_AGENT_TOKEN=<token> domo-mcp
//
// DOMO_AGENT_SOCKET is optional: if unset it defaults to the standard local
// broker for this machine (DomoPaths.agentSocket, honoring DOMO_HOME). It may
// also be a ws(s):// URL to reach a networked/hosted broker (runbook Phase 6);
// for wss, set DOMO_BROKER_PIN=<spki-base64> to pin the broker cert. Only the
// token is required, since it's the per-agent credential.
//
// Claude Code config (local socket omitted -> standard local broker):
//   claude mcp add domo -e DOMO_AGENT_TOKEN=... -- <path>/domo-mcp
// Hosted broker:
//   claude mcp add domo -e DOMO_AGENT_TOKEN=... \
//     -e DOMO_AGENT_SOCKET=wss://broker.example:8443/ -e DOMO_BROKER_PIN=... -- <path>/domo-mcp

let env = ProcessInfo.processInfo.environment
let endpoint = env["DOMO_AGENT_SOCKET"] ?? DomoPaths.agentSocket()
guard let token = env["DOMO_AGENT_TOKEN"] else {
    FileHandle.standardError.write(Data("domo-mcp: set DOMO_AGENT_TOKEN (DOMO_AGENT_SOCKET optional; defaults to \(endpoint))\n".utf8))
    exit(2)
}

func dialBroker() throws -> Connection {
    if endpoint.hasPrefix("ws://") || endpoint.hasPrefix("wss://"), let url = URL(string: endpoint) {
        var trust: PeerTrustEvaluator?
        if let pin = env["DOMO_BROKER_PIN"] {
            trust = SPKIPinningEvaluator(pins: [SPKIPin(sha256Base64: pin)])
        }
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
