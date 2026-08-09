import Foundation
import DomoProtocol

/// Generates the seatbelt (SBPL) profile for one approved command.
/// The profile is never authored — it is mechanically derived from the
/// capability set the human approved (DESIGN.md §6).
public enum SandboxProfile {
    static let readBoilerplate = [
        "/usr", "/bin", "/sbin", "/System", "/Library", "/opt",
        "/private/etc", "/private/var/db", "/private/var/select",
    ]

    static func quote(_ path: String) -> String {
        "\"" + path.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    public static func generate(readPaths: [String], writePaths: [String],
                                network: Bool, scratch: String) -> String {
        var lines: [String] = [
            "(version 1)",
            "(deny default)",
            "(allow process-fork)",
            "(allow process-exec)",
            "(allow process-info*)",
            "(allow signal (target children))",
            "(allow sysctl-read)",
            // TODO(v1.x): tighten to the specific services processes need.
            "(allow mach-lookup)",
            "(allow file-read-metadata)",
            "(allow file-ioctl)",
            "(allow file-read* " + (readBoilerplate.map { "(subpath \(quote($0)))" }
                + ["(literal \"/\")", "(literal \"/private\")", "(literal \"/private/var\")",
                   "(literal \"/private/tmp\")", "(literal \"/tmp\")", "(literal \"/var\")",
                   "(literal \"/etc\")", "(literal \"/Users\")",
                   "(literal \"/dev/null\")", "(literal \"/dev/urandom\")",
                   "(literal \"/dev/random\")", "(literal \"/dev/zero\")",
                   "(literal \"/dev/tty\")", "(subpath \"/dev/fd\")"]).joined(separator: " ") + ")",
            "(allow file-write-data (literal \"/dev/null\") (literal \"/dev/tty\") (subpath \"/dev/fd\"))",
        ]
        let home = PathUtil.canonicalize(NSHomeDirectory())
        // Broad READ of the user's home so tools installed under it and their
        // configs/libraries resolve (e.g. ~/.local/bin, ~/.config, ~/.nvm).
        // Writes stay scoped below — reads are the safe capability here, and
        // network is off unless approved, so this doesn't enable exfiltration.
        lines.append("(allow file-read* (subpath \(quote(home))))")
        // Writable: the approved write paths + scratch (also TMPDIR) + the
        // common tool "housekeeping" dirs under home, so a tool's incidental
        // cache/config writes don't get denied and break it.
        let housekeeping = ["Library/Caches", ".cache", ".config", ".local/state", ".npm"]
            .map { home + "/" + $0 }
        let writable = ([scratch] + writePaths + housekeeping).map { PathUtil.canonicalize($0) }
        for path in writable {
            lines.append("(allow file-write* (subpath \(quote(path))))")
            lines.append("(allow file-read* (subpath \(quote(path))))")
        }
        for path in readPaths.map({ PathUtil.canonicalize($0) }) {
            lines.append("(allow file-read* (subpath \(quote(path))))")
        }
        if network {
            lines.append("(allow network*)")
            lines.append("(allow system-socket)")
        } else {
            lines.append("(deny network*)")
        }
        return lines.joined(separator: "\n")
    }
}

public final class OutputBuffer {
    private let lock = NSLock()
    private var data = Data()
    private(set) var exitCode: Int32?
    private let doneSemaphore = DispatchSemaphore(value: 0)

    func append(_ chunk: Data) {
        lock.lock()
        data.append(chunk)
        lock.unlock()
    }

    func finish(exitCode: Int32) {
        lock.lock()
        self.exitCode = exitCode
        lock.unlock()
        doneSemaphore.signal()
    }

    /// Returns (new output since `since`, total length, running, exitCode).
    public func snapshot(since: Int) -> (Data, Int, Bool, Int32?) {
        lock.lock()
        defer { lock.unlock() }
        let start = min(max(since, 0), data.count)
        return (data.subdata(in: start..<data.count), data.count, exitCode == nil, exitCode)
    }

    /// Wait up to `timeout` for completion; true when finished.
    func waitForExit(timeout: TimeInterval) -> Bool {
        if doneSemaphore.wait(timeout: .now() + timeout) == .success {
            doneSemaphore.signal() // keep signalled for later waiters
            return true
        }
        return false
    }
}

public enum ExecutorError: Error, CustomStringConvertible {
    case launchFailed(String)
    case unknownHandle(String)

    public var description: String {
        switch self {
        case .launchFailed(let message): return "launch failed: \(message)"
        case .unknownHandle(let handle): return "unknown output handle: \(handle)"
        }
    }
}

public struct ExecResult {
    public var handle: String
    public var running: Bool
    public var exitCode: Int32?
    public var output: Data
    public var outputLength: Int
}

/// Runs approved commands under sandbox-exec with a per-run generated profile,
/// buffering merged stdout+stderr for the get_output streaming path.
public final class Executor {
    private let lock = NSLock()
    private var buffers: [String: OutputBuffer] = [:]
    public let scratchRoot: URL

    public init(scratchRoot: URL) {
        self.scratchRoot = scratchRoot
        try? FileManager.default.createDirectory(at: scratchRoot, withIntermediateDirectories: true)
    }

    public func run(argv: [String], cwd: String?, readPaths: [String], writePaths: [String],
                    network: Bool, waitMs: Int) throws -> ExecResult {
        guard !argv.isEmpty else { throw ExecutorError.launchFailed("empty argv") }
        let handle = UUID().uuidString
        let scratch = scratchRoot.appendingPathComponent(handle)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)

        // cwd must be readable for the process to even start; it was part of
        // the approved exec capability, so allowing it matches the approval.
        var reads = readPaths
        let workingDir = cwd.map { PathUtil.canonicalize($0) } ?? scratch.path
        reads.append(workingDir)

        let profile = SandboxProfile.generate(readPaths: reads, writePaths: writePaths,
                                              network: network, scratch: scratch.path)

        if ProcessInfo.processInfo.environment["DOMO_DEBUG_SANDBOX"] != nil {
            FileHandle.standardError.write(Data("=== PROFILE ===\n\(profile)\n=== ARGV ===\n\(argv)\n".utf8))
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
        process.arguments = ["-p", profile] + argv
        process.currentDirectoryURL = URL(fileURLWithPath: workingDir)
        // Use the REAL home so tools and their configs resolve; TMPDIR stays in
        // the (writable, disposable) scratch dir. PATH includes the user's bin
        // dirs so tools under ~/.local/bin etc. are found.
        let realHome = NSHomeDirectory()
        process.environment = [
            "PATH": "\(realHome)/.local/bin:\(realHome)/bin:\(realHome)/.cargo/bin"
                + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": realHome,
            "TMPDIR": scratch.path,
            "LANG": "en_US.UTF-8",
        ]

        let buffer = OutputBuffer()
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { fileHandle in
            let chunk = fileHandle.availableData
            if !chunk.isEmpty { buffer.append(chunk) }
        }
        process.terminationHandler = { proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            let remainder = pipe.fileHandleForReading.readDataToEndOfFile()
            if !remainder.isEmpty { buffer.append(remainder) }
            buffer.finish(exitCode: proc.terminationStatus)
        }

        lock.lock()
        buffers[handle] = buffer
        lock.unlock()

        do {
            try process.run()
        } catch {
            buffer.finish(exitCode: -1)
            throw ExecutorError.launchFailed(error.localizedDescription)
        }

        _ = buffer.waitForExit(timeout: TimeInterval(max(waitMs, 0)) / 1000.0)
        let (output, length, running, exitCode) = buffer.snapshot(since: 0)
        return ExecResult(handle: handle, running: running, exitCode: exitCode,
                          output: output, outputLength: length)
    }

    public func output(handle: String, since: Int) throws -> ExecResult {
        lock.lock()
        let buffer = buffers[handle]
        lock.unlock()
        guard let buffer else { throw ExecutorError.unknownHandle(handle) }
        let (output, length, running, exitCode) = buffer.snapshot(since: since)
        return ExecResult(handle: handle, running: running, exitCode: exitCode,
                          output: output, outputLength: length)
    }
}
