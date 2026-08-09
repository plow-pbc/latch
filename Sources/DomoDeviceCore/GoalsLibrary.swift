import Foundation

/// The Goals Library backing the Mac-initiated spin-up flow: premade and
/// user-authored goal documents an agent can be started with (DESIGN.md §2).
public struct Goal: Codable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var text: String
    public var premade: Bool

    public init(title: String, text: String, premade: Bool = false) {
        self.id = UUID().uuidString
        self.title = title
        self.text = text
        self.premade = premade
    }
}

public final class GoalsLibrary {
    private let url: URL
    private let lock = NSLock()
    private var goals: [Goal]

    public static let premade: [Goal] = [
        Goal(title: "Disk usage report",
             text: "Find the 20 largest files or folders in my home directory and write a summary report to ~/Desktop/disk-report.md.",
             premade: true),
        Goal(title: "Disk space to /tmp",
             text: "Check how much disk space I have and write it to a file. Ask for access to this Mac, run `df -h`, and save the output to /tmp/disk-space.txt.",
             premade: true),
        Goal(title: "msgvault search sam",
             text: "Run the command `msgvault search sam` and write its output to a file. Ask for access to this Mac, then run `msgvault search sam` and save the result to /tmp/msgvault-sam.txt.",
             premade: true),
    ]

    public init(url: URL) {
        self.url = url
        if let data = try? Data(contentsOf: url),
           let stored = try? JSONDecoder().decode([Goal].self, from: data) {
            // Always present the current premade set (so edits to `premade`
            // take effect), while keeping any goals the user created.
            goals = Self.premade + stored.filter { !$0.premade }
        } else {
            goals = Self.premade
        }
        persistLocked()
    }

    public func all() -> [Goal] {
        lock.lock()
        defer { lock.unlock() }
        return goals
    }

    public func add(_ goal: Goal) {
        lock.lock()
        goals.append(goal)
        lock.unlock()
        persistLocked()
    }

    public func remove(id: String) {
        lock.lock()
        goals.removeAll { $0.id == id }
        lock.unlock()
        persistLocked()
    }

    private func persistLocked() {
        lock.lock()
        let snapshot = goals
        lock.unlock()
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? encoder.encode(snapshot).write(to: url)
    }
}
