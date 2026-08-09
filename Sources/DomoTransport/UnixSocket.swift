import Foundation

/// Minimal blocking Unix-domain-socket primitives with newline-delimited
/// framing. Deliberately thread-per-connection: every principal here handles a
/// handful of connections, and blocking loops keep the code auditable.
///
/// This is the v1 implementation of the `Connection` seam; see Transport.swift.
public final class SocketConnection: Connection {
    public let fd: Int32
    private let writeLock = NSLock()
    private var readThread: Thread?
    private var closed = false
    private let stateLock = NSLock()

    public var onLine: ((Data) -> Void)?
    public var onClose: (() -> Void)?
    /// Server-owned close hook, invoked in addition to `onClose` so a server
    /// can drop its retained reference without fighting consumers over onClose.
    var onCloseInternal: (() -> Void)?

    public init(fd: Int32) {
        self.fd = fd
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    }

    public func startReading() {
        let thread = Thread { [weak self] in self?.readLoop() }
        thread.name = "domo.socket.read"
        readThread = thread
        thread.start()
    }

    private func readLoop() {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(contentsOf: chunk[0..<n])
            while let newlineIndex = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<newlineIndex)
                buffer.removeSubrange(buffer.startIndex...newlineIndex)
                if !line.isEmpty { onLine?(line) }
            }
        }
        close()
    }

    public func sendLine(_ data: Data) {
        writeLock.lock()
        defer { writeLock.unlock() }
        var out = data
        out.append(0x0A)
        out.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            var offset = 0
            while offset < raw.count {
                let n = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if n <= 0 { return }
                offset += n
            }
        }
    }

    public func close() {
        stateLock.lock()
        let wasClosed = closed
        closed = true
        stateLock.unlock()
        if wasClosed { return }
        Darwin.close(fd)
        onClose?()
        onCloseInternal?()
    }
}

public enum SocketError: Error, CustomStringConvertible {
    case system(String, Int32)
    case pathTooLong(String)

    public var description: String {
        switch self {
        case .system(let op, let errno): return "\(op) failed: \(String(cString: strerror(errno)))"
        case .pathTooLong(let path): return "socket path too long: \(path)"
        }
    }
}

private func makeSockaddrUn(path: String) throws -> sockaddr_un {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    let capacity = MemoryLayout.size(ofValue: addr.sun_path) - 1
    guard bytes.count <= capacity else { throw SocketError.pathTooLong(path) }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        for (i, b) in bytes.enumerated() { raw[i] = b }
        raw[bytes.count] = 0
    }
    return addr
}

public final class SocketServer: ConnectionListener {
    public let path: String
    private let fd: Int32
    private var acceptThread: Thread?
    private var stopped = false
    private let connLock = NSLock()
    private var connections: [ObjectIdentifier: SocketConnection] = [:]

    /// Handler configures the connection (sets onLine etc). The server retains
    /// the connection and starts its read loop afterward, so the handler must
    /// NOT call startReading itself.
    public var onConnection: ((Connection) -> Void)?

    public init(path: String) throws {
        self.path = path
        unlink(path)
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError.system("socket", errno) }
        var addr = try makeSockaddrUn(path: path)
        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                bind(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            Darwin.close(fd)
            throw SocketError.system("bind", errno)
        }
        chmod(path, 0o600)
        guard listen(fd, 16) == 0 else {
            Darwin.close(fd)
            throw SocketError.system("listen", errno)
        }
    }

    public func start() {
        let thread = Thread { [weak self] in self?.acceptLoop() }
        thread.name = "domo.socket.accept"
        acceptThread = thread
        thread.start()
    }

    private func acceptLoop() {
        while !stopped {
            let clientFd = accept(fd, nil, nil)
            if clientFd < 0 { break }
            let conn = SocketConnection(fd: clientFd)
            connLock.lock()
            connections[ObjectIdentifier(conn)] = conn
            connLock.unlock()
            conn.onCloseInternal = { [weak self, weak conn] in
                guard let self, let conn else { return }
                self.connLock.lock()
                self.connections.removeValue(forKey: ObjectIdentifier(conn))
                self.connLock.unlock()
            }
            onConnection?(conn)
            conn.startReading()
        }
    }

    public func stop() {
        stopped = true
        Darwin.close(fd)
        unlink(path)
    }
}

public enum SocketClient {
    public static func connect(path: String) throws -> SocketConnection {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError.system("socket", errno) }
        var addr = try makeSockaddrUn(path: path)
        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else {
            Darwin.close(fd)
            throw SocketError.system("connect", errno)
        }
        return SocketConnection(fd: fd)
    }
}
