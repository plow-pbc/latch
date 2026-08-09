import Foundation
import DomoProtocol

public extension Notification.Name {
    /// Posted (on some thread) whenever a new audit event is recorded, so UIs
    /// can refresh live. Everything flows through the app, so no polling/refresh
    /// button is needed — observe this and reload on the main queue.
    static let domoAuditDidChange = Notification.Name("domo.audit.didChange")
}

/// Append-only NDJSON audit log. One event per line. This is both the human
/// record and the test oracle (DESIGN.md §10), and the stream the future
/// adversarial reviewer consumes.
public final class AuditLog {
    public let url: URL
    private let lock = NSLock()
    private let dateFormatter = ISO8601DateFormatter()

    public init(url: URL) {
        self.url = url
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
    }

    public func record(_ event: String, _ fields: [String: JSONValue] = [:]) {
        var entry = fields
        entry["event"] = .string(event)
        entry["ts"] = .string(dateFormatter.string(from: Date()))
        let line = JSONValue.object(entry).encoded()
        lock.lock()
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(line)
            handle.write(Data([0x0A]))
            try? handle.close()
        } else {
            var data = line
            data.append(0x0A)
            try? data.write(to: url)
        }
        lock.unlock()
        NotificationCenter.default.post(name: .domoAuditDidChange, object: nil)
    }

    /// All events, oldest first. Used by tests and the audit UI.
    public func entries() -> [JSONValue] {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? Data(contentsOf: url) else { return [] }
        return data.split(separator: 0x0A).compactMap { try? JSONValue.parse(Data($0)) }
    }
}
