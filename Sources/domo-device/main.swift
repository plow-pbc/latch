import Foundation
import DomoProtocol
import DomoTransport
import DomoDeviceCore

// domo-device: headless device runner — the identical DomoDeviceCore the AppKit
// app uses, with a scripted policy instead of dialogs. This is what makes full
// end-to-end automated testing possible (DESIGN.md §10).
//
//   domo-device --home <dir> --broker <device.sock> [--name <name>] [--policy <config.json>]
//
// Policy config: {"access": "allow"|"deny",
//                 "intent": "allow_once"|"always_allow"|"deny",
//                 "denyKinds": ["process.exec", ...]}   (optional)

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

let rawArguments = Array(CommandLine.arguments.dropFirst())

if rawArguments.first == "identity" {
    // Print this Mac's device identity so a provisioner can enroll it
    // (runbook Phase 3): `domo-broker enroll-device --pubkey <publicKey>`.
    let options = parseArgs(Array(rawArguments.dropFirst()))
    let home = URL(fileURLWithPath: options["home"] ?? DomoPaths.defaultHome)
    do {
        let identity = try DeviceIdentity.loadOrCreate(
            home: home, defaultName: options["name"] ?? (Host.current().localizedName ?? "Mac"))
        let output: JSONValue = ["device_id": .string(identity.deviceId),
                                 "name": .string(identity.name),
                                 "publicKey": .string(identity.keyPair.publicKeyBase64)]
        print(output.jsonString())
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("domo-device identity failed: \(error)\n".utf8))
        exit(1)
    }
}

let options = parseArgs(rawArguments)
let home = URL(fileURLWithPath: options["home"] ?? DomoPaths.defaultHome)
let brokerSocket = options["broker"] ?? DomoPaths.deviceSocket(home: home.path)

do {
    let policy: HeadlessPolicy
    if let policyPath = options["policy"] {
        policy = try HeadlessPolicy(configURL: URL(fileURLWithPath: policyPath))
    } else {
        // Without a policy file the headless runner denies everything: silent
        // auto-approval must always be an explicit, visible choice.
        policy = HeadlessPolicy(config: .init(access: "deny", intent: "deny"))
    }
    let device = try DeviceAgent(home: home,
                                 name: options["name"] ?? (Host.current().localizedName ?? "Mac"),
                                 delegate: policy)
    device.onConnectionClosed = {
        FileHandle.standardError.write(Data("domo-device: broker connection closed\n".utf8))
        exit(1)
    }
    // A ws://host:port broker means the networked transport: dial out with
    // reconnect (runbook Phase 1). A path means the v1 Unix socket.
    if brokerSocket.hasPrefix("ws://") || brokerSocket.hasPrefix("wss://"),
       let url = URL(string: brokerSocket) {
        // `--authenticate` performs the enrollment challenge (needed against a
        // broker started with --require-enrollment). `--pin <spki-base64>` pins
        // the broker's self-signed cert instead of trusting the system CA store.
        let authenticate = options["authenticate"] != nil
        var trust: PeerTrustEvaluator?
        if let pin = options["pin"] {
            trust = SPKIPinningEvaluator(pins: [SPKIPin(sha256Base64: pin)])
        }
        try device.connect(dialer: WebSocketDialer(url: url, trust: trust),
                           reconnect: true, authenticate: authenticate)
    } else {
        try device.connect(brokerSocket: brokerSocket)
    }

    // Test/dev affordance: drive the Mac-initiated spawn flow at startup and
    // write the resulting agent token to a file (DESIGN.md §10).
    if let goal = options["spawn-goal"] {
        let spawned = try device.requestSpawnAgent(goal: goal)
        if let out = options["spawn-token-out"] {
            try spawned.encoded().write(to: URL(fileURLWithPath: out))
        }
    }

    FileHandle.standardOutput.write(Data("domo-device ready id=\(device.identity.deviceId)\n".utf8))
    withExtendedLifetime((device, policy)) {
        dispatchMain()
    }
} catch {
    FileHandle.standardError.write(Data("domo-device failed to start: \(error)\n".utf8))
    exit(1)
}
