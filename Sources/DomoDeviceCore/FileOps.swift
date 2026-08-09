import Foundation
import DomoProtocol

public enum FileOpsError: Error, CustomStringConvertible {
    case outOfBounds(String)
    case ioFailure(String)

    public var description: String {
        switch self {
        case .outOfBounds(let path): return "path outside approved scope: \(path)"
        case .ioFailure(let message): return message
        }
    }
}

/// In-process file operations, bounds-checked against the approved capability
/// paths. These run as trusted code in the device app — no sandbox needed —
/// which is exactly why every access must be canonicalized and scope-checked
/// (symlinks and ".." resolved) before touching the disk.
public enum FileOps {
    public static func read(path: String, allowedRoots: [String]) throws -> Data {
        let canonical = PathUtil.canonicalize(path)
        guard PathUtil.isWithin(canonical, roots: allowedRoots) else {
            throw FileOpsError.outOfBounds(path)
        }
        do {
            return try Data(contentsOf: URL(fileURLWithPath: canonical))
        } catch {
            throw FileOpsError.ioFailure("read failed: \(error.localizedDescription)")
        }
    }

    public static func write(path: String, data: Data, allowedRoots: [String]) throws {
        let canonical = PathUtil.canonicalize(path)
        guard PathUtil.isWithin(canonical, roots: allowedRoots) else {
            throw FileOpsError.outOfBounds(path)
        }
        do {
            let parent = URL(fileURLWithPath: canonical).deletingLastPathComponent()
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
            try data.write(to: URL(fileURLWithPath: canonical))
        } catch let error as FileOpsError {
            throw error
        } catch {
            throw FileOpsError.ioFailure("write failed: \(error.localizedDescription)")
        }
    }
}
