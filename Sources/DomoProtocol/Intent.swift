import Foundation

/// The unit of request in Domo. See DESIGN.md §4.
public struct Intent: Codable, Equatable {
    public var intentId: String
    public var agentId: String
    public var agentDisplay: String
    public var agentPublicKey: String
    public var deviceId: String
    public var goal: String?
    public var planContext: String?
    public var request: String
    public var capabilities: [Capability]
    public var createdAt: Date
    public var expiresAt: Date
    public var sessionId: String
    public var nonce: String
    public var signature: String?

    public init(agentId: String, agentDisplay: String, agentPublicKey: String,
                deviceId: String, goal: String?, planContext: String?,
                request: String, capabilities: [Capability],
                sessionId: String, ttl: TimeInterval = 120) {
        self.intentId = UUID().uuidString
        self.agentId = agentId
        self.agentDisplay = agentDisplay
        self.agentPublicKey = agentPublicKey
        self.deviceId = deviceId
        self.goal = goal
        self.planContext = planContext
        self.request = request
        self.capabilities = capabilities
        self.createdAt = Date()
        self.expiresAt = Date().addingTimeInterval(ttl)
        self.sessionId = sessionId
        self.nonce = UUID().uuidString
        self.signature = nil
    }

    /// Canonical bytes covered by the signature: the whole intent minus the
    /// signature field itself.
    public func signingData() -> Data {
        var unsigned = self
        unsigned.signature = nil
        return Canonical.encode(unsigned)
    }

    public mutating func sign(with keyPair: KeyPair) throws {
        signature = try keyPair.sign(signingData()).base64EncodedString()
    }

    /// Verifies the embedded signature against the embedded public key.
    /// Callers must additionally check the public key is the one pinned for
    /// this agent at access-grant time (DeviceAgent does).
    public func verifySignature() -> Bool {
        guard let signature, let sigData = Data(base64Encoded: signature) else { return false }
        return KeyPair.verify(signature: sigData, data: signingData(), publicKeyBase64: agentPublicKey)
    }

    public var isExpired: Bool { Date() > expiresAt }

    public var ruleKey: String {
        RuleKey.compute(agentId: agentId, deviceId: deviceId, capabilities: capabilities)
    }
}

public enum Decision: String, Codable {
    case allowOnce = "allow_once"
    case alwaysAllow = "always_allow"
    case deny = "deny"

    public var isAllowed: Bool { self != .deny }
}

/// The signed record of an approval decision.
public struct Grant: Codable, Equatable {
    public var intentId: String
    public var agentId: String
    public var deviceId: String
    public var decision: Decision
    public var capabilities: [Capability]
    public var ruleKey: String
    /// "prompt" (human/policy delegate decided) or "rule" (stored always-allow rule).
    public var source: String
    public var issuedAt: Date
    public var deviceSignature: String?

    public init(intent: Intent, decision: Decision, source: String) {
        self.intentId = intent.intentId
        self.agentId = intent.agentId
        self.deviceId = intent.deviceId
        self.decision = decision
        self.capabilities = intent.capabilities
        self.ruleKey = intent.ruleKey
        self.source = source
        self.issuedAt = Date()
        self.deviceSignature = nil
    }

    public func signingData() -> Data {
        var unsigned = self
        unsigned.deviceSignature = nil
        return Canonical.encode(unsigned)
    }

    public mutating func sign(with keyPair: KeyPair) throws {
        deviceSignature = try keyPair.sign(signingData()).base64EncodedString()
    }
}

/// A stored always-allow rule (exact capability match).
public struct AlwaysAllowRule: Codable, Equatable {
    public var ruleKey: String
    public var agentId: String
    public var agentDisplay: String
    public var deviceId: String
    public var capabilities: [Capability]
    public var createdAt: Date

    public init(from intent: Intent) {
        self.ruleKey = intent.ruleKey
        self.agentId = intent.agentId
        self.agentDisplay = intent.agentDisplay
        self.deviceId = intent.deviceId
        self.capabilities = intent.capabilities.map { $0.normalized() }
        self.createdAt = Date()
    }
}
