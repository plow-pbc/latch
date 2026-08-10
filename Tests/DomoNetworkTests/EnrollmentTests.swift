import XCTest
import Foundation
import DomoProtocol
import DomoTransport
import DomoBrokerCore
import DomoDeviceCore

/// Phase 3 acceptance (runbook §Phase 3): identities are authenticated on every
/// connect via a challenge signed by an ENROLLED key. A connection that fails the
/// challenge is dropped before any RPC; an unenrolled key is refused. (The
/// bad-token gate for agents is unchanged and still tested elsewhere.)
final class EnrollmentTests: XCTestCase {

    func testEnrolledDevicePassesChallengeAndRuns() throws {
        let stack = try NetworkStack(requireEnrollment: true)
        defer { stack.shutdown() }
        XCTAssertTrue(stack.broker.isDeviceOnline(stack.deviceId),
                      "an enrolled device should pass the challenge and register")

        let agent = stack.createAgent(name: "Enrolled Session")
        let client = try NetworkMCPClient(dialer: stack.agentDialer(), token: agent.token)
        try client.initializeSession()
        let (access, _) = try client.callTool("request_device_access", [
            "device": .string(stack.deviceId), "goals": "authenticated session",
        ])
        XCTAssertEqual(access["status"].str, "granted")
        let (result, isError) = try client.callTool("run_command", [
            "device": .string(stack.deviceId), "argv": ["/bin/echo", "authenticated"],
        ])
        XCTAssertFalse(isError)
        XCTAssertEqual(result["output"].str, "authenticated\n")
        client.close()
    }

    func testPairByCodeThenConnect() throws {
        let env = try EnrollmentBroker(requireEnrollment: true)
        defer { env.shutdown() }

        let policy = HeadlessPolicy(config: .init(access: "allow", intent: "allow_once"))
        let device = try DeviceAgent(home: env.home.appendingPathComponent("pairme"),
                                     name: "PairMe", delegate: policy)
        defer { device.disconnect() }

        // 1) Device submits a pairing request with a code shown on its screen.
        let code = "PAIR42"
        XCTAssertTrue(try device.pair(dialer: env.deviceDialer(), code: code),
                      "broker should acknowledge the pairing request")

        // 2) It shows up as pending, bound to this device's key.
        let pending = env.broker.store.pendingPairings()
        XCTAssertEqual(pending.first?.code, code)
        XCTAssertEqual(pending.first?.deviceId, device.identity.deviceId)

        // Before approval, the device still can't connect.
        XCTAssertThrowsError(try device.connect(dialer: env.deviceDialer(), authenticate: true))
        device.disconnect()

        // 3) Provisioner approves that code → device is enrolled.
        let record = env.broker.store.approvePairing(code: code)
        XCTAssertEqual(record?.deviceId, device.identity.deviceId)
        XCTAssertTrue(env.broker.store.pendingPairings().isEmpty)

        // 4) Now the same device connects and registers.
        let online = try DeviceAgent(home: env.home.appendingPathComponent("pairme"),
                                     name: "PairMe", delegate: policy)
        defer { online.disconnect() }
        try online.connect(dialer: env.deviceDialer(), authenticate: true)
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline && !env.broker.isDeviceOnline(online.identity.deviceId) {
            Thread.sleep(forTimeInterval: 0.03)
        }
        XCTAssertTrue(env.broker.isDeviceOnline(online.identity.deviceId),
                      "an approved device should connect")
    }

    func testUnenrolledDeviceRefused() throws {
        let env = try EnrollmentBroker(requireEnrollment: true)
        defer { env.shutdown() }

        let policy = HeadlessPolicy(config: .init(access: "allow", intent: "allow_once"))
        let device = try DeviceAgent(home: env.home.appendingPathComponent("rogue"),
                                     name: "Rogue", delegate: policy)
        defer { device.disconnect() }
        // Deliberately NOT enrolled.
        XCTAssertThrowsError(try device.connect(dialer: env.deviceDialer(), authenticate: true),
                             "an unenrolled device must be refused at the challenge")
        Thread.sleep(forTimeInterval: 0.3)
        XCTAssertFalse(env.broker.isDeviceOnline(device.identity.deviceId),
                       "a refused device must never register — no RPC after a failed challenge")
    }

    func testBadChallengeSignatureDroppedBeforeRPC() throws {
        let env = try EnrollmentBroker(requireEnrollment: true)
        defer { env.shutdown() }

        // Enroll a legitimate identity key...
        let enrolled = KeyPair()
        let deviceId = enrolled.fingerprint
        env.broker.store.enrollDevice(deviceId: deviceId, name: "Victim",
                                      publicKeyBase64: enrolled.publicKeyBase64)

        // ...then present that enrolled public key with a signature made by a
        // DIFFERENT key. The broker must reject before any RPC.
        let conn = try env.deviceDialer().connect()
        let semaphore = DispatchSemaphore(value: 0)
        var gotAuthError = false
        var gotAuthOk = false
        conn.onLine = { line in
            guard let msg = try? JSONValue.parse(line), let type = msg["type"].str else { return }
            switch type {
            case "challenge":
                let wrong = try! DeviceChallenge.sign(nonce: msg["nonce"].str!, keyPair: KeyPair())
                conn.sendLine(JSONValue.object([
                    "type": "challenge-response",
                    "deviceId": .string(deviceId),
                    "publicKey": .string(enrolled.publicKeyBase64),
                    "signature": .string(wrong),
                ]).encoded())
            case "auth-error": gotAuthError = true; semaphore.signal()
            case "auth-ok": gotAuthOk = true; semaphore.signal()
            default: break
            }
        }
        conn.startReading()
        _ = semaphore.wait(timeout: .now() + 5)
        conn.close()

        XCTAssertTrue(gotAuthError, "a forged challenge signature must be rejected")
        XCTAssertFalse(gotAuthOk)
        XCTAssertFalse(env.broker.isDeviceOnline(deviceId),
                       "no device link is created before the challenge passes")
    }

    // MARK: - DeviceKeyStore seam

    func testFileDeviceKeyStoreRoundTrip() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("domo-keystore-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("device-key.json")

        let store = FileDeviceKeyStore(url: url)
        XCTAssertNil(store.loadKey())
        let created = KeyPair()
        try store.storeKey(created)
        // A fresh store instance must load the identical key.
        let reloaded = FileDeviceKeyStore(url: url).loadKey()
        XCTAssertEqual(reloaded?.publicKeyBase64, created.publicKeyBase64)
    }

    func testKeychainDeviceKeyStoreRoundTrip() throws {
        // Real keychain; skip gracefully where it isn't writable (restricted CI),
        // so the suite never hangs on a keychain prompt.
        let store = KeychainDeviceKeyStore(service: "com.tumult.domo.test",
                                           account: "roundtrip-\(UUID().uuidString.prefix(8))")
        let created = KeyPair()
        do {
            try store.storeKey(created)
        } catch {
            throw XCTSkip("keychain not writable here: \(error)")
        }
        defer { store.deleteKey() }
        XCTAssertEqual(store.loadKey()?.publicKeyBase64, created.publicKeyBase64)
    }
}

/// Minimal in-process enrollment-mode broker with a WebSocket device listener,
/// for the negative-path tests that need to drive connect themselves.
final class EnrollmentBroker {
    let home: URL
    let broker: Broker
    let devicePort: UInt16
    private let deviceListener: WebSocketListener
    private let agentListener: WebSocketListener

    init(requireEnrollment: Bool) throws {
        home = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("domo-enroll-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        deviceListener = try WebSocketListener(port: 0)
        deviceListener.start()
        devicePort = deviceListener.waitForPort()!
        agentListener = try WebSocketListener(port: 0)
        agentListener.start()
        broker = try Broker(home: home, agentListener: agentListener, deviceListener: deviceListener,
                            agentEndpoint: "ws://127.0.0.1:\(agentListener.waitForPort()!)/",
                            requireEnrollment: requireEnrollment)
    }

    func deviceDialer() -> WebSocketDialer {
        WebSocketDialer(url: URL(string: "ws://127.0.0.1:\(devicePort)/")!, timeout: 5)
    }

    func shutdown() {
        broker.stop()
        try? FileManager.default.removeItem(at: home)
    }
}
