import Foundation
import DomoProtocol

/// Whoever answers approval questions: the AppKit NSAlert flow, the headless
/// scripted policy for tests, or (later) the iOS remote-approval relay and the
/// adversarial reviewer agent.
public protocol PolicyDelegate: AnyObject {
    func decideAccess(agentId: String, agentDisplay: String, goals: String,
                      completion: @escaping (Bool) -> Void)
    func decideIntent(_ intent: Intent, completion: @escaping (Decision) -> Void)
}

/// Applies stored always-allow rules before ever consulting the delegate.
/// Rules match on (agent, device, exact normalized capability set) — never on
/// goal text (DESIGN.md §5).
public final class PolicyEngine {
    private let rulesURL: URL
    private let lock = NSLock()
    private var rules: [String: AlwaysAllowRule]

    public init(rulesURL: URL) {
        self.rulesURL = rulesURL
        if let data = try? Data(contentsOf: rulesURL),
           let stored = try? JSONDecoder.domo.decode([AlwaysAllowRule].self, from: data) {
            rules = Dictionary(uniqueKeysWithValues: stored.map { ($0.ruleKey, $0) })
        } else {
            rules = [:]
        }
    }

    public func allRules() -> [AlwaysAllowRule] {
        lock.lock()
        defer { lock.unlock() }
        return Array(rules.values).sorted { $0.createdAt < $1.createdAt }
    }

    public func removeRule(key: String) {
        lock.lock()
        rules.removeValue(forKey: key)
        lock.unlock()
        persist()
    }

    public func removeAllRules() {
        lock.lock()
        rules = [:]
        lock.unlock()
        persist()
    }

    private func persist() {
        lock.lock()
        let snapshot = Array(rules.values)
        lock.unlock()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        try? FileManager.default.createDirectory(at: rulesURL.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? encoder.encode(snapshot).write(to: rulesURL)
    }

    public func decide(_ intent: Intent, delegate: PolicyDelegate,
                       completion: @escaping (Grant) -> Void) {
        let key = intent.ruleKey
        lock.lock()
        let matched = rules[key] != nil
        lock.unlock()
        if matched {
            completion(Grant(intent: intent, decision: .alwaysAllow, source: "rule"))
            return
        }
        delegate.decideIntent(intent) { [weak self] decision in
            if decision == .alwaysAllow, let self {
                self.lock.lock()
                self.rules[key] = AlwaysAllowRule(from: intent)
                self.lock.unlock()
                self.persist()
            }
            completion(Grant(intent: intent, decision: decision, source: "prompt"))
        }
    }
}

/// Scripted decisions for the headless device runner — the piece that makes
/// full-stack automated E2E testing possible without a UI (DESIGN.md §10).
public final class HeadlessPolicy: PolicyDelegate {
    public struct Config: Codable {
        public var access: String       // "allow" | "deny"
        public var intent: String       // "allow_once" | "always_allow" | "deny"
        public var denyKinds: [String]? // capability kinds to always deny

        public init(access: String = "allow", intent: String = "allow_once",
                    denyKinds: [String]? = nil) {
            self.access = access
            self.intent = intent
            self.denyKinds = denyKinds
        }
    }

    public let config: Config

    public init(config: Config) {
        self.config = config
    }

    public convenience init(configURL: URL) throws {
        let data = try Data(contentsOf: configURL)
        self.init(config: try JSONDecoder().decode(Config.self, from: data))
    }

    public func decideAccess(agentId: String, agentDisplay: String, goals: String,
                             completion: @escaping (Bool) -> Void) {
        completion(config.access == "allow")
    }

    public func decideIntent(_ intent: Intent, completion: @escaping (Decision) -> Void) {
        if let denyKinds = config.denyKinds,
           intent.capabilities.contains(where: { denyKinds.contains($0.kind.rawValue) }) {
            completion(.deny)
            return
        }
        completion(Decision(rawValue: config.intent) ?? .deny)
    }
}
