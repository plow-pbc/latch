import Foundation

/// A bidirectional, newline-framed message connection — the seam the rest of
/// Domo is built on. `LineRPC`, the broker, and the device all speak to a
/// `Connection`, never to a concrete socket. The Unix-domain-socket transport
/// (`SocketConnection`) is the v1 implementation; a TLS/WebSocket transport for
/// the networked milestone conforms to the same protocol and drops in with no
/// changes above this line.
///
/// See docs/network-security-runbook.md for how the networked transport slots
/// in here, and DESIGN.md §8 for the security model.
public protocol Connection: AnyObject {
    var onLine: ((Data) -> Void)? { get set }
    var onClose: (() -> Void)? { get set }
    /// Begin delivering inbound lines via `onLine`. Called once by the owner.
    func startReading()
    /// Send one framed message (a trailing newline is added by the transport).
    func sendLine(_ data: Data)
    func close()
}

/// Accepts inbound `Connection`s — the broker's server side. The Unix
/// `SocketServer` is the v1 implementation; a TLS/WebSocket listener conforms
/// here for the networked milestone.
public protocol ConnectionListener: AnyObject {
    /// Configure the connection (set `onLine` etc). The listener retains the
    /// connection and starts its read loop afterward, so handlers must NOT call
    /// `startReading` themselves.
    var onConnection: ((Connection) -> Void)? { get set }
    func start()
    func stop()
}

/// Dials an outbound `Connection` — the Mac/agent client side. `UnixSocketDialer`
/// is v1; a TLS/WebSocket dialer (carrying the broker URL + a `PeerTrustEvaluator`)
/// conforms here for the networked milestone.
public protocol ConnectionDialer {
    func connect() throws -> Connection
}

/// v1 dialer: connects to a local Unix domain socket by path.
public struct UnixSocketDialer: ConnectionDialer {
    public let path: String
    public init(path: String) { self.path = path }
    public func connect() throws -> Connection { try SocketClient.connect(path: path) }
}
