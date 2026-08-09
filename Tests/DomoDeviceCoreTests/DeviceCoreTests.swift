import XCTest
@testable import DomoDeviceCore
@testable import DomoProtocol

func tempDir(_ prefix: String) -> URL {
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("\(prefix)-\(UUID().uuidString.prefix(8))")
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

// MARK: - Policy engine

private final class ScriptedDelegate: PolicyDelegate {
    var nextDecision: Decision = .allowOnce
    private(set) var promptCount = 0

    func decideAccess(agentId: String, agentDisplay: String, goals: String,
                      completion: @escaping (Bool) -> Void) {
        completion(true)
    }

    func decideIntent(_ intent: Intent, completion: @escaping (Decision) -> Void) {
        promptCount += 1
        completion(nextDecision)
    }
}

final class PolicyEngineTests: XCTestCase {
    func makeIntent(agent: KeyPair, paths: [String] = ["/tmp/x"]) -> Intent {
        Intent(agentId: agent.fingerprint, agentDisplay: "Test",
               agentPublicKey: agent.publicKeyBase64, deviceId: "device-1",
               goal: nil, planContext: nil, request: "read",
               capabilities: [Capability(kind: .fsRead, paths: paths)],
               sessionId: "session")
    }

    private func decide(_ engine: PolicyEngine, _ intent: Intent, _ delegate: ScriptedDelegate) -> Grant {
        var grant: Grant?
        let done = expectation(description: "decision")
        engine.decide(intent, delegate: delegate) { grant = $0; done.fulfill() }
        wait(for: [done], timeout: 5)
        return grant!
    }

    func testAlwaysAllowStoresRuleAndSkipsPrompt() {
        let home = tempDir("domo-policy")
        defer { try? FileManager.default.removeItem(at: home) }
        let engine = PolicyEngine(rulesURL: home.appendingPathComponent("rules.json"))
        let delegate = ScriptedDelegate()
        let agent = KeyPair()

        delegate.nextDecision = .alwaysAllow
        let first = decide(engine, makeIntent(agent: agent), delegate)
        XCTAssertEqual(first.source, "prompt")
        XCTAssertEqual(delegate.promptCount, 1)

        // Same capability set: rule matches, no second prompt.
        let second = decide(engine, makeIntent(agent: agent), delegate)
        XCTAssertEqual(second.source, "rule")
        XCTAssertTrue(second.decision.isAllowed)
        XCTAssertEqual(delegate.promptCount, 1)

        // Different path: exact match misses, prompts again.
        let third = decide(engine, makeIntent(agent: agent, paths: ["/tmp/other"]), delegate)
        XCTAssertEqual(third.source, "prompt")
        XCTAssertEqual(delegate.promptCount, 2)
    }

    func testRulesPersistAcrossReload() {
        let home = tempDir("domo-policy")
        defer { try? FileManager.default.removeItem(at: home) }
        let rulesURL = home.appendingPathComponent("rules.json")
        let delegate = ScriptedDelegate()
        let agent = KeyPair()

        delegate.nextDecision = .alwaysAllow
        _ = decide(PolicyEngine(rulesURL: rulesURL), makeIntent(agent: agent), delegate)

        let reloaded = PolicyEngine(rulesURL: rulesURL)
        let grant = decide(reloaded, makeIntent(agent: agent), delegate)
        XCTAssertEqual(grant.source, "rule")
        XCTAssertEqual(reloaded.allRules().count, 1)
    }

    func testDenyIsNotStored() {
        let home = tempDir("domo-policy")
        defer { try? FileManager.default.removeItem(at: home) }
        let engine = PolicyEngine(rulesURL: home.appendingPathComponent("rules.json"))
        let delegate = ScriptedDelegate()
        let agent = KeyPair()

        delegate.nextDecision = .deny
        let first = decide(engine, makeIntent(agent: agent), delegate)
        XCTAssertFalse(first.decision.isAllowed)
        XCTAssertEqual(engine.allRules().count, 0)

        // Denial must not create a rule in either direction.
        let second = decide(engine, makeIntent(agent: agent), delegate)
        XCTAssertEqual(second.source, "prompt")
        XCTAssertEqual(delegate.promptCount, 2)
    }
}

// MARK: - File ops

final class FileOpsTests: XCTestCase {
    func testReadWriteWithinScope() throws {
        let root = tempDir("domo-fileops")
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("sub/file.txt")
        try FileOps.write(path: file.path, data: Data("hello".utf8), allowedRoots: [root.path])
        let read = try FileOps.read(path: file.path, allowedRoots: [root.path])
        XCTAssertEqual(String(data: read, encoding: .utf8), "hello")
    }

    func testOutOfScopeRejected() {
        let root = tempDir("domo-fileops")
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertThrowsError(try FileOps.read(path: "/etc/passwd", allowedRoots: [root.path]))
        XCTAssertThrowsError(try FileOps.write(path: "/tmp/evil.txt", data: Data(),
                                               allowedRoots: [root.path]))
    }

    func testTraversalRejected() throws {
        let root = tempDir("domo-fileops")
        defer { try? FileManager.default.removeItem(at: root) }
        let sneaky = root.path + "/../escape.txt"
        XCTAssertThrowsError(try FileOps.write(path: sneaky, data: Data("x".utf8),
                                               allowedRoots: [root.path]))
    }

    func testSymlinkEscapeRejected() throws {
        let base = tempDir("domo-fileops")
        defer { try? FileManager.default.removeItem(at: base) }
        let inside = base.appendingPathComponent("inside")
        let outside = base.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: inside, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let secret = outside.appendingPathComponent("secret.txt")
        try Data("secret".utf8).write(to: secret)
        try FileManager.default.createSymbolicLink(
            at: inside.appendingPathComponent("link"),
            withDestinationURL: outside)
        XCTAssertThrowsError(try FileOps.read(path: inside.appendingPathComponent("link/secret.txt").path,
                                              allowedRoots: [inside.path]))
    }
}

// MARK: - Sandbox / executor

final class SandboxProfileTests: XCTestCase {
    func testProfileContainsApprovedPathsAndDeniesNetwork() {
        let profile = SandboxProfile.generate(readPaths: ["/private/tmp/r"],
                                              writePaths: ["/private/tmp/w"],
                                              network: false, scratch: "/private/tmp/s")
        XCTAssertTrue(profile.contains("(deny default)"))
        XCTAssertTrue(profile.contains("(allow file-read* (subpath \"/private/tmp/r\"))"))
        XCTAssertTrue(profile.contains("(allow file-write* (subpath \"/private/tmp/w\"))"))
        XCTAssertTrue(profile.contains("(deny network*)"))
        XCTAssertFalse(profile.contains("(allow network*)"))
    }

    func testProfileAllowsHomeReadAndHousekeepingWrites() {
        let profile = SandboxProfile.generate(readPaths: [], writePaths: [], network: false,
                                              scratch: "/private/tmp/s")
        let home = PathUtil.canonicalize(NSHomeDirectory())
        XCTAssertTrue(profile.contains("(allow file-read* (subpath \"\(home)\"))"),
                      "home should be broadly readable so tools/configs load")
        XCTAssertTrue(profile.contains("Library/Caches"),
                      "tool housekeeping dirs should be writable")
    }

    func testQuotingResistsProfileInjection() {
        let profile = SandboxProfile.generate(
            readPaths: ["/tmp/evil\") (allow file-write* (subpath \"/\")"],
            writePaths: [], network: false, scratch: "/private/tmp/s")
        // The malicious path must stay inside one quoted string.
        XCTAssertFalse(profile.contains("(allow file-write* (subpath \"/\")"))
    }
}

final class ExecutorTests: XCTestCase {
    func makeExecutor() -> (Executor, URL) {
        let home = tempDir("domo-exec")
        return (Executor(scratchRoot: home.appendingPathComponent("scratch")), home)
    }

    func testSimpleCommandRuns() throws {
        let (executor, home) = makeExecutor()
        defer { try? FileManager.default.removeItem(at: home) }
        let result = try executor.run(argv: ["/bin/echo", "hello sandbox"], cwd: nil,
                                      readPaths: [], writePaths: [], network: false,
                                      waitMs: 10000)
        XCTAssertFalse(result.running)
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(String(data: result.output, encoding: .utf8), "hello sandbox\n")
    }

    func testCanReadUserHomeWithoutDeclaring() throws {
        // Tools live under the real home (~/.local/bin, configs). The sandbox
        // grants broad read of $HOME, so a command can read there even without
        // declaring it as a read path.
        let (executor, home) = makeExecutor()
        defer { try? FileManager.default.removeItem(at: home) }
        let marker = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".domo-sandbox-test-\(UUID().uuidString.prefix(8)).txt")
        try Data("home-visible".utf8).write(to: marker)
        defer { try? FileManager.default.removeItem(at: marker) }
        let result = try executor.run(argv: ["/bin/cat", marker.path], cwd: nil,
                                      readPaths: [], writePaths: [], network: false, waitMs: 10000)
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(String(data: result.output, encoding: .utf8), "home-visible")
    }

    func testRunsToolFromUserLocalBin() throws {
        // A tool installed under ~/.local/bin should be found (PATH) and run
        // (home is readable/executable) — the real-world case this fix targets.
        let (executor, home) = makeExecutor()
        defer { try? FileManager.default.removeItem(at: home) }
        let binDir = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".local/bin")
        try FileManager.default.createDirectory(at: binDir, withIntermediateDirectories: true)
        let toolName = "domo-tooltest-\(UUID().uuidString.prefix(8))"
        let tool = binDir.appendingPathComponent(toolName)
        try "#!/bin/bash\necho tool-ran\n".write(to: tool, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tool.path)
        defer { try? FileManager.default.removeItem(at: tool) }
        let result = try executor.run(argv: ["/bin/sh", "-c", toolName], cwd: nil,
                                      readPaths: [], writePaths: [], network: false, waitMs: 10000)
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(String(data: result.output, encoding: .utf8), "tool-ran\n")
    }

    func testWriteInsideApprovedPathSucceeds() throws {
        let (executor, home) = makeExecutor()
        defer { try? FileManager.default.removeItem(at: home) }
        let writable = tempDir("domo-exec-w")
        defer { try? FileManager.default.removeItem(at: writable) }
        let target = writable.appendingPathComponent("out.txt")
        let result = try executor.run(argv: ["/bin/sh", "-c", "echo approved > \(target.path)"],
                                      cwd: nil, readPaths: [], writePaths: [writable.path],
                                      network: false, waitMs: 10000)
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "approved\n")
    }

    func testWriteOutsideApprovedPathBlocked() throws {
        let (executor, home) = makeExecutor()
        defer { try? FileManager.default.removeItem(at: home) }
        let forbidden = tempDir("domo-exec-forbidden")
        defer { try? FileManager.default.removeItem(at: forbidden) }
        let target = forbidden.appendingPathComponent("escape.txt")
        // Sandbox was only granted a different write path.
        let allowed = tempDir("domo-exec-allowed")
        defer { try? FileManager.default.removeItem(at: allowed) }
        let result = try executor.run(argv: ["/bin/sh", "-c", "echo escape > \(target.path)"],
                                      cwd: nil, readPaths: [], writePaths: [allowed.path],
                                      network: false, waitMs: 10000)
        XCTAssertNotEqual(result.exitCode, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }

    func testReadOutsideApprovedPathBlocked() throws {
        let (executor, home) = makeExecutor()
        defer { try? FileManager.default.removeItem(at: home) }
        let secretDir = tempDir("domo-exec-secret")
        defer { try? FileManager.default.removeItem(at: secretDir) }
        let secret = secretDir.appendingPathComponent("secret.txt")
        try Data("top secret".utf8).write(to: secret)
        let result = try executor.run(argv: ["/bin/cat", secret.path], cwd: nil,
                                      readPaths: [], writePaths: [], network: false,
                                      waitMs: 10000)
        XCTAssertNotEqual(result.exitCode, 0)
        let output = String(data: result.output, encoding: .utf8) ?? ""
        XCTAssertFalse(output.contains("top secret"))
    }

    func testStreamingViaHandle() throws {
        let (executor, home) = makeExecutor()
        defer { try? FileManager.default.removeItem(at: home) }
        let result = try executor.run(
            argv: ["/bin/sh", "-c", "echo first; sleep 1; echo second"],
            cwd: nil, readPaths: [], writePaths: [], network: false, waitMs: 300)
        XCTAssertTrue(result.running)
        let firstOutput = String(data: result.output, encoding: .utf8) ?? ""
        XCTAssertTrue(firstOutput.contains("first"))
        XCTAssertFalse(firstOutput.contains("second"))

        // Poll until completion, only asking for new bytes.
        var seen = result.outputLength
        var tail = ""
        for _ in 0..<40 {
            let chunk = try executor.output(handle: result.handle, since: seen)
            tail += String(data: chunk.output, encoding: .utf8) ?? ""
            seen = chunk.outputLength
            if !chunk.running { break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTAssertTrue(tail.contains("second"))
        XCTAssertFalse(tail.contains("first"), "since-offset should skip already-seen output")
        let final = try executor.output(handle: result.handle, since: 0)
        XCTAssertEqual(final.exitCode, 0)
    }

    func testNetworkDeniedBlocksLocalFetch() throws {
        // Deterministic network check: a local HTTP server this test runs.
        let server = try TrivialHTTPServer()
        defer { server.stop() }
        let (executor, home) = makeExecutor()
        defer { try? FileManager.default.removeItem(at: home) }
        let url = "http://127.0.0.1:\(server.port)/"

        let denied = try executor.run(argv: ["/usr/bin/curl", "-s", "--max-time", "3", url],
                                      cwd: nil, readPaths: [], writePaths: [],
                                      network: false, waitMs: 15000)
        XCTAssertNotEqual(denied.exitCode, 0)

        let allowed = try executor.run(argv: ["/usr/bin/curl", "-s", "--max-time", "3", url],
                                       cwd: nil, readPaths: [], writePaths: [],
                                       network: true, waitMs: 15000)
        XCTAssertEqual(allowed.exitCode, 0)
        XCTAssertEqual(String(data: allowed.output, encoding: .utf8), "domo-ok")
    }
}

/// Minimal HTTP/1.0 server for the network sandbox test.
final class TrivialHTTPServer {
    let port: UInt16
    private let fd: Int32

    init() throws {
        // Use a local fd throughout init; assign properties only at the end so
        // no closure captures a partially-initialized self.
        let serverFd = socket(AF_INET, SOCK_STREAM, 0)
        var one: Int32 = 1
        setsockopt(serverFd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(serverFd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0, listen(serverFd, 4) == 0 else {
            throw SocketTestError.setup
        }
        var bound = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        withUnsafeMutablePointer(to: &bound) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                _ = getsockname(serverFd, $0, &len)
            }
        }
        port = UInt16(bigEndian: bound.sin_port)
        fd = serverFd
        let thread = Thread {
            while true {
                let client = accept(serverFd, nil, nil)
                if client < 0 { break }
                var buf = [UInt8](repeating: 0, count: 1024)
                _ = read(client, &buf, buf.count)
                let response = "HTTP/1.0 200 OK\r\nContent-Length: 7\r\n\r\ndomo-ok"
                _ = response.withCString { write(client, $0, strlen($0)) }
                close(client)
            }
        }
        self.thread = thread
        thread.start()
    }

    private var thread: Thread?
    enum SocketTestError: Error { case setup }

    func stop() {
        close(fd)
    }
}
