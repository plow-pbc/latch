import XCTest
@testable import DomoProtocol

final class JSONValueTests: XCTestCase {
    func testRoundTrip() throws {
        let value: JSONValue = ["a": 1, "b": [true, "x", nil], "c": ["d": 2.5]]
        let parsed = try JSONValue.parse(value.encoded())
        XCTAssertEqual(parsed, value)
    }

    func testCanonicalDeterminism() {
        let a: JSONValue = ["z": 1, "a": 2, "m": ["k": "v"]]
        let b: JSONValue = ["a": 2, "m": ["k": "v"], "z": 1]
        XCTAssertEqual(a.encoded(), b.encoded())
    }

    func testBoolNumberDisambiguation() throws {
        let parsed = try JSONValue.parse(#"{"flag": true, "count": 1}"#)
        XCTAssertEqual(parsed["flag"].boolValue, true)
        XCTAssertNil(parsed["flag"].num)
        XCTAssertEqual(parsed["count"].int, 1)
    }
}

final class SigningTests: XCTestCase {
    func makeIntent(agent: KeyPair) -> Intent {
        Intent(agentId: agent.fingerprint, agentDisplay: "Test Agent",
               agentPublicKey: agent.publicKeyBase64, deviceId: "device-1",
               goal: "test goal", planContext: nil, request: "read file: /tmp/x",
               capabilities: [Capability(kind: .fsRead, paths: ["/tmp/x"])],
               sessionId: "session-1")
    }

    func testSignAndVerify() throws {
        let agent = KeyPair()
        var intent = makeIntent(agent: agent)
        XCTAssertFalse(intent.verifySignature())
        try intent.sign(with: agent)
        XCTAssertTrue(intent.verifySignature())
    }

    func testTamperedIntentFailsVerification() throws {
        let agent = KeyPair()
        var intent = makeIntent(agent: agent)
        try intent.sign(with: agent)
        intent.capabilities = [Capability(kind: .fsWrite, paths: ["/etc/passwd"])]
        XCTAssertFalse(intent.verifySignature())
    }

    func testWrongKeyFailsVerification() throws {
        let agent = KeyPair()
        let impostor = KeyPair()
        var intent = makeIntent(agent: agent)
        // Impostor signs but the embedded public key is the real agent's.
        intent.signature = try impostor.sign(intent.signingData()).base64EncodedString()
        XCTAssertFalse(intent.verifySignature())
    }
}

final class RuleKeyTests: XCTestCase {
    func testReasonAndOrderDoNotAffectKey() {
        let a = [
            Capability(kind: .fsRead, paths: ["/tmp/b", "/tmp/a"], reason: "because"),
            Capability(kind: .network, allowed: false),
        ]
        let b = [
            Capability(kind: .network, allowed: false),
            Capability(kind: .fsRead, paths: ["/tmp/a", "/tmp/b"], reason: "different reason"),
        ]
        XCTAssertEqual(RuleKey.compute(agentId: "x", deviceId: "d", capabilities: a),
                       RuleKey.compute(agentId: "x", deviceId: "d", capabilities: b))
    }

    func testDifferentArgvChangesKey() {
        let status = [Capability(kind: .processExec, argv: ["git", "status"])]
        let push = [Capability(kind: .processExec, argv: ["git", "push"])]
        XCTAssertNotEqual(RuleKey.compute(agentId: "x", deviceId: "d", capabilities: status),
                          RuleKey.compute(agentId: "x", deviceId: "d", capabilities: push))
    }

    func testDifferentAgentChangesKey() {
        let caps = [Capability(kind: .fsRead, paths: ["/tmp/a"])]
        XCTAssertNotEqual(RuleKey.compute(agentId: "agent1", deviceId: "d", capabilities: caps),
                          RuleKey.compute(agentId: "agent2", deviceId: "d", capabilities: caps))
    }
}

final class PathUtilTests: XCTestCase {
    func testDotDotCollapse() {
        XCTAssertEqual(PathUtil.canonicalize("/private/tmp/foo/../bar"), "/private/tmp/bar")
    }

    func testIsWithin() {
        XCTAssertTrue(PathUtil.isWithin("/private/tmp/a/b", root: "/private/tmp/a"))
        XCTAssertTrue(PathUtil.isWithin("/private/tmp/a", root: "/private/tmp/a"))
        XCTAssertFalse(PathUtil.isWithin("/private/tmp/ab", root: "/private/tmp/a"))
        XCTAssertFalse(PathUtil.isWithin("/private/tmp/a/../b", root: "/private/tmp/a"))
    }

    func testSymlinkEscapeDetected() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("domo-pathtest-\(UUID().uuidString.prefix(8))")
        let inside = base.appendingPathComponent("inside")
        let outside = base.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: inside, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: inside.appendingPathComponent("link"),
            withDestinationURL: outside)
        defer { try? FileManager.default.removeItem(at: base) }
        XCTAssertFalse(PathUtil.isWithin(inside.appendingPathComponent("link/secret").path,
                                         root: inside.path))
    }
}
