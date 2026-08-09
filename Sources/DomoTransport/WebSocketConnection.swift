import Foundation
import Network
import Security

/// Networked implementation of the `Connection` seam over WebSocket
/// (Network.framework `NWConnection`/`NWListener`). This is the drop-in the
/// runbook's Phase 1 promised: everything above `LineRPC` speaks `Connection`,
/// so switching the Mac + agent from Unix sockets to the network changes only
/// which dialer/listener is constructed.
///
/// Framing: one WebSocket message == one logical line. We deliberately do NOT
/// re-add newline scanning — WS already delimits messages, and honoring the
/// "one message in, one message out" contract is all `LineRPC` needs. See
/// docs/network-security-runbook.md Phase 1.
public final class WebSocketConnection: Connection {
    private let nw: NWConnection
    private let queue: DispatchQueue

    public var onLine: ((Data) -> Void)?
    public var onClose: (() -> Void)?
    /// Listener-owned close hook, invoked in addition to `onClose` so a server
    /// can drop its retained reference without fighting consumers over onClose
    /// (mirrors `SocketConnection.onCloseInternal`).
    var onCloseInternal: (() -> Void)?

    private let stateLock = NSLock()
    private var started = false
    private var closed = false

    // Ready signaling for the outbound (dial) path, so `connect()` can fail
    // synchronously on a handshake/TLS-pin failure — matching UnixSocketDialer.
    private let readySemaphore = DispatchSemaphore(value: 0)
    private var readyError: Error?
    private var didSignalReady = false

    public init(connection: NWConnection, queue: DispatchQueue) {
        self.nw = connection
        self.queue = queue
    }

    /// Idempotently install the state handler and start the underlying
    /// connection. Both the dial path (via `waitUntilReady`) and the listener's
    /// `startReading` funnel through here so the connection is started exactly
    /// once regardless of which side owns it.
    private func ensureStarted() {
        stateLock.lock()
        if started { stateLock.unlock(); return }
        started = true
        stateLock.unlock()

        nw.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.signalReady(nil)
            case .failed(let error):
                self.signalReady(error)
                self.handleClosed()
            case .cancelled:
                self.signalReady(NWError.posix(.ECANCELED))
                self.handleClosed()
            case .waiting(let error):
                // A dial that can't reach the endpoint sits in .waiting; surface
                // it as a ready failure so connect() doesn't hang to its timeout.
                self.signalReady(error)
            default:
                break
            }
        }
        nw.start(queue: queue)
    }

    private func signalReady(_ error: Error?) {
        stateLock.lock()
        if didSignalReady { stateLock.unlock(); return }
        didSignalReady = true
        readyError = error
        stateLock.unlock()
        readySemaphore.signal()
    }

    /// Start the connection and block until the WebSocket/TLS handshake
    /// completes (or fails/times out). Used by the dialer so a bad pin or an
    /// unreachable broker throws instead of surfacing later.
    func waitUntilReady(timeout: TimeInterval) throws {
        ensureStarted()
        if readySemaphore.wait(timeout: .now() + timeout) != .success {
            close()
            throw RPCError("websocket connect timed out")
        }
        stateLock.lock()
        let error = readyError
        stateLock.unlock()
        if let error {
            close()
            throw RPCError("websocket connect failed: \(error)")
        }
    }

    public func startReading() {
        ensureStarted()
        receiveNext()
    }

    private func receiveNext() {
        nw.receiveMessage { [weak self] data, context, _, error in
            guard let self else { return }
            if let context,
               let meta = context.protocolMetadata(definition: NWProtocolWebSocket.definition)
                   as? NWProtocolWebSocket.Metadata,
               meta.opcode == .close {
                self.handleClosed()
                return
            }
            if let data, !data.isEmpty { self.onLine?(data) }
            if error != nil { self.handleClosed(); return }
            self.stateLock.lock(); let done = self.closed; self.stateLock.unlock()
            if done { return }
            self.receiveNext()
        }
    }

    public func sendLine(_ data: Data) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
        let context = NWConnection.ContentContext(identifier: "msg", metadata: [metadata])
        nw.send(content: data, contentContext: context, isComplete: true,
                completion: .contentProcessed({ _ in }))
    }

    public func close() {
        stateLock.lock()
        let wasClosed = closed
        closed = true
        stateLock.unlock()
        if wasClosed { return }
        // Graceful close: unlike a Unix socket's synchronous write(), NWConnection
        // sends asynchronously, so cancel() would drop a just-queued frame (e.g. a
        // domo-auth-error) before it flushes. Enqueue a WS close frame — it is
        // ordered AFTER prior sends — and cancel only once it is processed.
        let meta = NWProtocolWebSocket.Metadata(opcode: .close)
        let context = NWConnection.ContentContext(identifier: "close", metadata: [meta])
        nw.send(content: nil, contentContext: context, isComplete: true,
                completion: .contentProcessed({ [weak nw] _ in nw?.cancel() }))
        onClose?()
        onCloseInternal?()
    }

    private func handleClosed() {
        stateLock.lock()
        let wasClosed = closed
        closed = true
        stateLock.unlock()
        if wasClosed { return }
        nw.cancel()
        onClose?()
        onCloseInternal?()
    }
}

/// Builds the shared TLS + WebSocket protocol stack. Trust is decided by the
/// injected `PeerTrustEvaluator` (Phase 2 pinning) INSTEAD of the system CA
/// store — that is what makes self-signed + pinning the intended posture. Pass
/// `trust == nil` for a plain `ws://` stack (Phase-1 loopback tests only).
enum WebSocketStack {
    static func clientParameters(trust: PeerTrustEvaluator?, verifyQueue: DispatchQueue) -> NWParameters {
        let params: NWParameters
        if let trust {
            let tlsOptions = NWProtocolTLS.Options()
            sec_protocol_options_set_verify_block(tlsOptions.securityProtocolOptions,
                                                  { _, sec_trust, complete in
                let secTrust = sec_trust_copy_ref(sec_trust).takeRetainedValue()
                complete(trust.evaluate(derChain: derChain(of: secTrust)))
            }, verifyQueue)
            params = NWParameters(tls: tlsOptions)
        } else {
            params = NWParameters(tls: nil)
        }
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)
        return params
    }

    static func serverParameters(identity: SecIdentity?) -> NWParameters {
        let params: NWParameters
        if let identity, let secIdentity = sec_identity_create(identity) {
            let tlsOptions = NWProtocolTLS.Options()
            sec_protocol_options_set_local_identity(tlsOptions.securityProtocolOptions, secIdentity)
            params = NWParameters(tls: tlsOptions)
        } else {
            params = NWParameters(tls: nil)
        }
        params.allowLocalEndpointReuse = true
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)
        return params
    }

    /// Peer certificate chain, leaf first, DER-encoded — the input the
    /// `PeerTrustEvaluator` pins against.
    static func derChain(of trust: SecTrust) -> [Data] {
        if #available(macOS 12.0, *) {
            let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] ?? []
            return chain.map { SecCertificateCopyData($0) as Data }
        } else {
            var result: [Data] = []
            let count = SecTrustGetCertificateCount(trust)
            for i in 0..<count {
                if let cert = SecTrustGetCertificateAtIndex(trust, i) {
                    result.append(SecCertificateCopyData(cert) as Data)
                }
            }
            return result
        }
    }
}

/// Outbound dialer: the Mac (and the agent) dial the broker URL. Carries the
/// `PeerTrustEvaluator` used to pin the broker's certificate (Phase 2). For a
/// plain-`ws://` URL, pass `trust == nil`.
public struct WebSocketDialer: ConnectionDialer {
    public let url: URL
    public let trust: PeerTrustEvaluator?
    public let timeout: TimeInterval

    public init(url: URL, trust: PeerTrustEvaluator? = nil, timeout: TimeInterval = 15) {
        self.url = url
        self.trust = trust
        self.timeout = timeout
    }

    public func connect() throws -> Connection {
        let queue = DispatchQueue(label: "domo.ws.client")
        let params = WebSocketStack.clientParameters(trust: trust, verifyQueue: queue)
        let nw = NWConnection(to: .url(url), using: params)
        let conn = WebSocketConnection(connection: nw, queue: queue)
        try conn.waitUntilReady(timeout: timeout)
        return conn
    }
}

/// Inbound listener: the broker's server side. Mirrors `SocketServer` — it
/// retains accepted connections and starts their read loop after the handler
/// configures them, so handlers must NOT call `startReading` themselves.
public final class WebSocketListener: ConnectionListener {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "domo.ws.listener")
    private let connLock = NSLock()
    private var connections: [ObjectIdentifier: WebSocketConnection] = [:]
    private let portSemaphore = DispatchSemaphore(value: 0)
    private var boundPort: UInt16?

    public var onConnection: ((Connection) -> Void)?

    /// `identity` supplies the server certificate for `wss://` (Phase 2). Pass
    /// nil for a plain `ws://` listener (Phase-1 loopback tests only).
    public init(port: UInt16, identity: SecIdentity? = nil) throws {
        let params = WebSocketStack.serverParameters(identity: identity)
        listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port) ?? .any)
    }

    public func start() {
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            if case .ready = state {
                self.boundPort = self.listener.port?.rawValue
                self.portSemaphore.signal()
            }
        }
        listener.newConnectionHandler = { [weak self] nw in
            guard let self else { return }
            let conn = WebSocketConnection(connection: nw, queue: self.queue)
            self.connLock.lock()
            self.connections[ObjectIdentifier(conn)] = conn
            self.connLock.unlock()
            conn.onCloseInternal = { [weak self, weak conn] in
                guard let self, let conn else { return }
                self.connLock.lock()
                self.connections.removeValue(forKey: ObjectIdentifier(conn))
                self.connLock.unlock()
            }
            self.onConnection?(conn)
            conn.startReading()
        }
        listener.start(queue: queue)
    }

    /// The actual bound port (useful when constructed with port 0 in tests).
    /// Blocks until the listener is ready.
    public func waitForPort(timeout: TimeInterval = 5) -> UInt16? {
        _ = portSemaphore.wait(timeout: .now() + timeout)
        return boundPort
    }

    public func stop() {
        listener.cancel()
        connLock.lock()
        let live = Array(connections.values)
        connections.removeAll()
        connLock.unlock()
        for conn in live { conn.close() }
    }
}
