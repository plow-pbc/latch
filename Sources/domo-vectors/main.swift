import Foundation
import CryptoKit
import DomoProtocol
import DomoDeviceCore

// domo-vectors: emits the golden conformance fixtures for the TypeScript port
// (DESIGN.md §13, Phase T1). Swift is the generator of truth until it is
// decommissioned; both test suites assert these files byte-for-byte.
//
//   swift run domo-vectors --out fixtures
//
// Fixture families:
//   canonical-json.json  encoding determinism (sorting, escaping, numbers)
//   identity.json        Ed25519 keys/fingerprints/signatures (deterministic)
//   intent.json          intent + grant + rule signing bytes and signatures
//   rulekeys.json        rule-key normalization (ordering, reason-stripping)
//   connection.json      DomoConnection compact/deep-link forms
//   challenge.json       device challenge signing
//   channel.json         E2E channel key schedule + AEAD framing (fixed nonces)
//   pathutil.json        canonicalize cases (macOS-stable /tmp, /var symlinks)
//   sbpl.json            sandbox profiles — MACHINE-DEPENDENT (embeds $HOME)

func argValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count else { return nil }
    return args[i + 1]
}

let outDir = URL(fileURLWithPath: argValue("out") ?? "fixtures")
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

func writeFixture(_ name: String, _ value: JSONValue) {
    // Pretty-print for reviewability; the *values inside* carry the canonical bytes.
    let data = try! JSONSerialization.data(
        withJSONObject: JSONSerialization.jsonObject(with: value.encoded()),
        options: [.prettyPrinted, .sortedKeys])
    try! data.write(to: outDir.appendingPathComponent(name))
    print("wrote \(name)")
}

func hexData(_ hex: String) -> Data {
    var data = Data()
    var chars = Array(hex)
    while chars.count >= 2 {
        data.append(UInt8(String(chars[0...1]), radix: 16)!)
        chars.removeFirst(2)
    }
    return data
}

// Deterministic seeds — fixture constants, never real keys.
let seedA = hexData("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
let seedB = hexData("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f")
let keyA = try! KeyPair(rawRepresentation: seedA)
let keyB = try! KeyPair(rawRepresentation: seedB)

// MARK: - canonical-json

let canonicalCases: [(String, JSONValue)] = [
    ("empty-object", [:]),
    ("empty-array", []),
    ("null", nil),
    ("bools", [true, false]),
    ("key-sorting", ["zeta": 1, "alpha": 2, "Zebra": 3, "0num": 4, "~tilde": 5, "_under": 6]),
    ("nested", ["b": ["d": [1, 2, 3], "c": ["x": nil]], "a": "v"]),
    ("string-escapes", ["quote": "say \"hi\"", "backslash": "a\\b", "newline": "l1\nl2",
                        "tab": "a\tb", "cr": "a\rb", "ctrl": "a\u{01}b", "del": "a\u{7f}b"]),
    ("slashes-not-escaped", ["url": "wss://broker.example:8444/path"]),
    ("unicode-raw", ["emoji": "🙂", "accents": "café", "cjk": "日本語"]),
    ("numbers-integral", [0, 1, -1, 42, 1000000, 9007199254740992]),
    ("numbers-fractional", [1.5, -0.5, 0.1, 3.14159, 0.001]),
    ("mixed", ["list": [1, "two", true, nil, ["k": "v"]], "n": 2.5]),
]

writeFixture("canonical-json.json", .object([
    "cases": .array(canonicalCases.map { name, value in
        .object(["name": .string(name), "value": value,
                 "canonical": .string(value.jsonString())])
    }),
]))

// MARK: - identity

let message = Data("domo golden vector message: signatures are deterministic (RFC 8032)".utf8)
writeFixture("identity.json", .object([
    "keys": .array([keyA, keyB].enumerated().map { index, key in
        .object([
            "name": .string(index == 0 ? "A" : "B"),
            "seedBase64": .string(key.privateKeyBase64),
            "publicKeyBase64": .string(key.publicKeyBase64),
            "fingerprint": .string(key.fingerprint),
        ])
    }),
    "message": .string(String(data: message, encoding: .utf8)!),
    "signatureA": .string(try! keyA.sign(message).base64EncodedString()),
    "signatureB": .string(try! keyB.sign(message).base64EncodedString()),
    "sha256HexOfMessage": .string(Hashing.sha256Hex(message)),
]))

// MARK: - intent / grant / rule

let iso = ISO8601DateFormatter()
var intent = Intent(
    agentId: keyA.fingerprint, agentDisplay: "Golden Agent",
    agentPublicKey: keyA.publicKeyBase64, deviceId: keyB.fingerprint,
    goal: "resize the café photos 🙂 (see wss://broker/path)",
    planContext: "session plan context",
    request: "run: sips -Z 1600 /domo-fixture-nonexistent/in/../photos",
    capabilities: [
        Capability(kind: .processExec, argv: ["sips", "-Z", "1600", "photos"],
                   cwd: "/domo-fixture-nonexistent/work/./dir"),
        Capability(kind: .network, allowed: false),
        Capability(kind: .fsWrite, paths: ["/domo-fixture-nonexistent/out"], reason: "output dir"),
        Capability(kind: .fsRead,
                   paths: ["/domo-fixture-nonexistent/b", "/domo-fixture-nonexistent/a/sub/.."],
                   reason: "inputs"),
    ],
    sessionId: "fixture-session-0001")
intent.intentId = "fixture-intent-0001"
intent.nonce = "fixture-nonce-0001"
intent.createdAt = iso.date(from: "2026-08-09T12:00:00Z")!
intent.expiresAt = iso.date(from: "2026-08-09T12:02:00Z")!
try! intent.sign(with: keyA)

var grant = Grant(intent: intent, decision: .alwaysAllow, source: "prompt")
grant.issuedAt = iso.date(from: "2026-08-09T12:00:05Z")!
try! grant.sign(with: keyB)

var rule = AlwaysAllowRule(from: intent)
rule.createdAt = iso.date(from: "2026-08-09T12:00:05Z")!

writeFixture("intent.json", .object([
    "intent": JSONValue.from(intent),
    "signingData": .string(String(data: intent.signingData(), encoding: .utf8)!),
    "signature": .string(intent.signature!),
    "ruleKey": .string(intent.ruleKey),
    "grant": JSONValue.from(grant),
    "grantSigningData": .string(String(data: grant.signingData(), encoding: .utf8)!),
    "grantSignature": .string(grant.deviceSignature!),
    "rule": JSONValue.from(rule),
]))

// MARK: - rule keys

let capsOrderOne = [
    Capability(kind: .fsRead, paths: ["/domo-fixture-nonexistent/b", "/domo-fixture-nonexistent/a"],
               reason: "will be stripped"),
    Capability(kind: .processExec, argv: ["git", "status"], cwd: "/domo-fixture-nonexistent/repo"),
]
let capsOrderTwo = [
    Capability(kind: .processExec, argv: ["git", "status"],
               cwd: "/domo-fixture-nonexistent/x/../repo", reason: "different display text"),
    Capability(kind: .fsRead, paths: ["/domo-fixture-nonexistent/a/", "/domo-fixture-nonexistent/b"]),
]
writeFixture("rulekeys.json", .object([
    "cases": .array([
        .object([
            "name": .string("order-and-reason-invariant"),
            "agentId": .string("agent-1"), "deviceId": .string("device-1"),
            "capabilitiesA": JSONValue.from(capsOrderOne),
            "capabilitiesB": JSONValue.from(capsOrderTwo),
            "ruleKey": .string(RuleKey.compute(agentId: "agent-1", deviceId: "device-1",
                                               capabilities: capsOrderOne)),
            "sameKey": .bool(RuleKey.compute(agentId: "agent-1", deviceId: "device-1",
                                             capabilities: capsOrderOne) ==
                             RuleKey.compute(agentId: "agent-1", deviceId: "device-1",
                                             capabilities: capsOrderTwo)),
        ]),
        .object([
            "name": .string("network-and-tool"),
            "agentId": .string("agent-2"), "deviceId": .string("device-2"),
            "capabilitiesA": JSONValue.from([Capability(kind: .network, allowed: true),
                                             Capability(kind: .tool, tool: "mac_info")]),
            "ruleKey": .string(RuleKey.compute(
                agentId: "agent-2", deviceId: "device-2",
                capabilities: [Capability(kind: .network, allowed: true),
                               Capability(kind: .tool, tool: "mac_info")])),
        ]),
    ]),
]))

// MARK: - connection strings

let deviceConn = DomoConnection(url: "wss://broker.example:8444/", pin: "u2eNSaHU3wjW3EBFH1BVYFFiV/PBAI87nqTM9NCBybU=",
                                name: "Domo broker", authenticate: true)
let agentConn = DomoConnection(url: "wss://broker.example:8443/", pin: "u2eNSaHU3wjW3EBFH1BVYFFiV/PBAI87nqTM9NCBybU=",
                               token: "fixture-token-0001", name: "Golden Agent")
let plainConn = DomoConnection(url: "ws://127.0.0.1:8443/")
writeFixture("connection.json", .object([
    "cases": .array([deviceConn, agentConn, plainConn].map { conn in
        .object([
            "url": .string(conn.url),
            "pin": conn.pin.map { .string($0) } ?? .null,
            "token": conn.token.map { .string($0) } ?? .null,
            "name": conn.name.map { .string($0) } ?? .null,
            "authenticate": .bool(conn.authenticate),
            "compact": .string(conn.compactString()),
            "deepLink": .string(conn.deepLink()),
        ])
    }),
]))

// MARK: - challenge

let challengeNonce = "fixture-challenge-nonce-0001"
writeFixture("challenge.json", .object([
    "context": .string(DeviceChallenge.context),
    "nonce": .string(challengeNonce),
    "signingDataBase64": .string(DeviceChallenge.signingData(nonce: challengeNonce).base64EncodedString()),
    "signatureA": .string(try! DeviceChallenge.sign(nonce: challengeNonce, keyPair: keyA)),
]))

// MARK: - E2E channel key schedule + AEAD framing

let ephASeed = hexData("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f")
let ephBSeed = hexData("606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f")
let ephA = try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: ephASeed)
let ephB = try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: ephBSeed)
let shared = try! ephA.sharedSecretFromKeyAgreement(with: ephB.publicKey)
let sharedData = shared.withUnsafeBytes { Data($0) }
let ePubA = ephA.publicKey.rawRepresentation
let ePubB = ephB.publicKey.rawRepresentation
let salt = ePubA + ePubB // initiator ephemeral first
let i2r = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
                                         sharedInfo: Data("domo-e2e:i2r".utf8), outputByteCount: 32)
let r2i = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
                                         sharedInfo: Data("domo-e2e:r2i".utf8), outputByteCount: 32)
let i2rData = i2r.withUnsafeBytes { Data($0) }
let r2iData = r2i.withUnsafeBytes { Data($0) }

let fixedNonce = hexData("000000000000000000000001")
let framePlain = Data("hello through the blind relay 🙂".utf8)
let sealed = try! ChaChaPoly.seal(framePlain, using: i2r,
                                  nonce: ChaChaPoly.Nonce(data: fixedNonce))

// Handshake signature vectors (contexts + sign-over layouts from E2EChannel).
let msg1Sig = try! keyA.sign(Data("domo-e2e-init:v1:".utf8) + ePubA)
let msg2Sig = try! keyB.sign(Data("domo-e2e-resp:v1:".utf8) + ePubB + ePubA)

writeFixture("channel.json", .object([
    "initContext": .string("domo-e2e-init:v1:"),
    "respContext": .string("domo-e2e-resp:v1:"),
    "hkdfInfoI2R": .string("domo-e2e:i2r"),
    "hkdfInfoR2I": .string("domo-e2e:r2i"),
    "initiatorIdentitySeedBase64": .string(seedA.base64EncodedString()),
    "responderIdentitySeedBase64": .string(seedB.base64EncodedString()),
    "initiatorEphemeralSeedBase64": .string(ephASeed.base64EncodedString()),
    "responderEphemeralSeedBase64": .string(ephBSeed.base64EncodedString()),
    "initiatorEphemeralPublicBase64": .string(ePubA.base64EncodedString()),
    "responderEphemeralPublicBase64": .string(ePubB.base64EncodedString()),
    "sharedSecretBase64": .string(sharedData.base64EncodedString()),
    "i2rKeyBase64": .string(i2rData.base64EncodedString()),
    "r2iKeyBase64": .string(r2iData.base64EncodedString()),
    "msg1SignatureBase64": .string(msg1Sig.base64EncodedString()),
    "msg2SignatureBase64": .string(msg2Sig.base64EncodedString()),
    "aead": .object([
        "keyBase64": .string(i2rData.base64EncodedString()),
        "nonceBase64": .string(fixedNonce.base64EncodedString()),
        "plaintextBase64": .string(framePlain.base64EncodedString()),
        "combinedBase64": .string(sealed.combined.base64EncodedString()),
    ]),
]))

// MARK: - path canonicalization (macOS-stable cases only)

let pathCases = [
    "/domo-fixture-nonexistent/a/b/../c",
    "/domo-fixture-nonexistent/./x/./y",
    "/domo-fixture-nonexistent/../escape",
    "/tmp/domo-fixture/file.txt",          // /tmp -> /private/tmp on macOS
    "/var/domo-fixture",                    // /var -> /private/var on macOS
    "/etc/hosts",                           // /etc -> /private/etc (existing file)
    "relative/path/file",                   // resolved against cwd at runtime
]
writeFixture("pathutil.json", .object([
    "cwdAtGeneration": .string(FileManager.default.currentDirectoryPath),
    "cases": .array(pathCases.map { p in
        .object(["input": .string(p), "canonical": .string(PathUtil.canonicalize(p))])
    }),
]))

// MARK: - SBPL profiles (machine-dependent: embeds $HOME)

let sbplCases: [(String, [String], [String], Bool, String)] = [
    ("read-write-no-network",
     ["/domo-fixture-nonexistent/in"], ["/domo-fixture-nonexistent/out"], false,
     "/domo-fixture-nonexistent/scratch/run1"),
    ("network-allowed", [], [], true, "/domo-fixture-nonexistent/scratch/run2"),
    ("tmp-paths", ["/tmp/domo-sbpl-fixture"], ["/tmp/domo-sbpl-fixture/out"], false,
     "/tmp/domo-sbpl-fixture/scratch"),
]
writeFixture("sbpl.json", .object([
    "home": .string(NSHomeDirectory()),
    "canonicalHome": .string(PathUtil.canonicalize(NSHomeDirectory())),
    "note": .string("machine-dependent: regenerate with `swift run domo-vectors` on this machine"),
    "cases": .array(sbplCases.map { name, reads, writes, network, scratch in
        .object([
            "name": .string(name),
            "readPaths": .array(reads.map { .string($0) }),
            "writePaths": .array(writes.map { .string($0) }),
            "network": .bool(network),
            "scratch": .string(scratch),
            "profile": .string(SandboxProfile.generate(readPaths: reads, writePaths: writes,
                                                       network: network, scratch: scratch)),
        ])
    }),
]))

print("done: \(outDir.path)")
