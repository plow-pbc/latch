import Foundation

/// One declared capability inside an intent. The set of capabilities is what
/// the human approves and what the sandbox profile is derived from.
public struct Capability: Codable, Equatable {
    public enum Kind: String, Codable {
        case fsRead = "fs.read"
        case fsWrite = "fs.write"
        case processExec = "process.exec"
        case network = "network"
        case tool = "tool"
    }

    public var kind: Kind
    public var paths: [String]?      // fs.read / fs.write
    public var argv: [String]?       // process.exec (argv[0] is the executable)
    public var cwd: String?          // process.exec
    public var allowed: Bool?        // network
    public var tool: String?         // tool
    public var reason: String?       // display-only justification

    public init(kind: Kind, paths: [String]? = nil, argv: [String]? = nil,
                cwd: String? = nil, allowed: Bool? = nil, tool: String? = nil,
                reason: String? = nil) {
        self.kind = kind
        self.paths = paths
        self.argv = argv
        self.cwd = cwd
        self.allowed = allowed
        self.tool = tool
        self.reason = reason
    }

    /// Normalized form used for rule keys: display-only fields stripped,
    /// paths canonicalized and sorted so equivalent requests hash identically.
    public func normalized() -> Capability {
        var c = self
        c.reason = nil
        if let p = c.paths {
            c.paths = p.map { PathUtil.canonicalize($0) }.sorted()
        }
        if let w = c.cwd {
            c.cwd = PathUtil.canonicalize(w)
        }
        return c
    }

    /// Human-readable one-liner for approval UIs and audit logs.
    public var display: String {
        switch kind {
        case .fsRead: return "Read: \((paths ?? []).joined(separator: ", "))"
        case .fsWrite: return "Write: \((paths ?? []).joined(separator: ", "))"
        case .processExec:
            let cmd = (argv ?? []).joined(separator: " ")
            return "Run: \(cmd)" + (cwd.map { " (in \($0))" } ?? "")
        case .network: return (allowed ?? false) ? "Network: allowed" : "Network: denied"
        case .tool: return "Tool: \(tool ?? "?")"
        }
    }
}

public enum RuleKey {
    /// Exact-capability-match rule key (DESIGN.md §5): SHA-256 over the
    /// canonical JSON of agent + device + normalized capabilities.
    /// Goal text is deliberately excluded — it is unverifiable.
    public static func compute(agentId: String, deviceId: String, capabilities: [Capability]) -> String {
        struct KeyPayload: Encodable {
            let agent: String
            let device: String
            let caps: [Capability]
        }
        let normalized = capabilities.map { $0.normalized() }.sorted { a, b in
            String(data: Canonical.encode(a), encoding: .utf8)! <
                String(data: Canonical.encode(b), encoding: .utf8)!
        }
        let payload = KeyPayload(agent: agentId, device: deviceId, caps: normalized)
        return Hashing.sha256Hex(Canonical.encode(payload))
    }
}

public enum PathUtil {
    /// Canonicalize to a TRUE physical path: expand ~, make absolute, collapse
    /// "." / "..", and resolve symlinks via realpath() on the longest existing
    /// prefix (appending any not-yet-existing remainder).
    ///
    /// This must return the real path the kernel sees (e.g. /private/var/…, not
    /// /var/…) because seatbelt enforces against physical paths — Foundation's
    /// resolvingSymlinksInPath does the opposite (it *strips* /private), which
    /// silently breaks sandbox scoping. It also resolves symlinks in the
    /// existing prefix, which is what makes symlink-escape detection correct.
    public static func canonicalize(_ path: String) -> String {
        var p = (path as NSString).expandingTildeInPath
        if !p.hasPrefix("/") {
            p = FileManager.default.currentDirectoryPath + "/" + p
        }
        // Collapse "." and ".." lexically first.
        var stack: [String] = []
        for component in p.split(separator: "/", omittingEmptySubsequences: true) {
            if component == "." { continue }
            if component == ".." { if !stack.isEmpty { stack.removeLast() }; continue }
            stack.append(String(component))
        }

        // Walk from the leaf up to find the longest existing prefix, realpath
        // it, then re-append the components below it.
        var remainder: [String] = []
        var prefix = stack
        while !prefix.isEmpty {
            let candidate = "/" + prefix.joined(separator: "/")
            if let resolved = realpathOrNil(candidate) {
                return ([resolved] + remainder.reversed()).joined(separator: "/")
            }
            remainder.append(prefix.removeLast())
        }
        return "/" + (remainder.reversed()).joined(separator: "/")
    }

    private static func realpathOrNil(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    /// True when `path` is `root` or inside it, after canonicalization.
    public static func isWithin(_ path: String, root: String) -> Bool {
        let p = canonicalize(path)
        let r = canonicalize(root)
        return p == r || p.hasPrefix(r.hasSuffix("/") ? r : r + "/")
    }

    public static func isWithin(_ path: String, roots: [String]) -> Bool {
        roots.contains { isWithin(path, root: $0) }
    }
}
