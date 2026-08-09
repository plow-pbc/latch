import Foundation
import DomoProtocol

public struct RPCError: Error, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// Symmetric JSON-RPC-style messaging over NDJSON: both sides can issue
/// requests ({id, method, params}) and receive responses ({id, result|error}).
/// Used on the broker↔device channel. Handlers run off the read thread so a
/// slow approval prompt never blocks the connection.
public final class LineRPC {
    public typealias Handler = (JSONValue, @escaping (Result<JSONValue, RPCError>) -> Void) -> Void

    private let conn: Connection
    private let lock = NSLock()
    private var handlers: [String: Handler] = [:]
    private var pending: [Int: (Result<JSONValue, RPCError>) -> Void] = [:]
    private var nextId = 1
    private let handlerQueue = DispatchQueue(label: "domo.rpc.handlers", attributes: .concurrent)

    public var onClose: (() -> Void)?

    public init(connection: Connection) {
        conn = connection
        conn.onLine = { [weak self] line in self?.handleLine(line) }
        conn.onClose = { [weak self] in self?.handleClose() }
    }

    public func start() {
        conn.startReading()
    }

    public func register(_ method: String, _ handler: @escaping Handler) {
        lock.lock()
        handlers[method] = handler
        lock.unlock()
    }

    private func handleLine(_ line: Data) {
        guard let message = try? JSONValue.parse(line) else { return }
        if let method = message["method"].str {
            let id = message["id"].int
            lock.lock()
            let handler = handlers[method]
            lock.unlock()
            guard let handler else {
                if let id { send(["id": .number(Double(id)), "error": ["message": .string("unknown method \(method)")]]) }
                return
            }
            handlerQueue.async { [weak self] in
                handler(message["params"]) { result in
                    guard let self, let id else { return }
                    switch result {
                    case .success(let value):
                        self.send(["id": .number(Double(id)), "result": value])
                    case .failure(let error):
                        self.send(["id": .number(Double(id)), "error": ["message": .string(error.message)]])
                    }
                }
            }
        } else if let id = message["id"].int {
            lock.lock()
            let completion = pending.removeValue(forKey: id)
            lock.unlock()
            if !message["error"].isNull {
                completion?(.failure(RPCError(message["error"]["message"].str ?? "remote error")))
            } else {
                completion?(.success(message["result"]))
            }
        }
    }

    private func handleClose() {
        lock.lock()
        let waiting = pending
        pending = [:]
        lock.unlock()
        for (_, completion) in waiting {
            completion(.failure(RPCError("connection closed")))
        }
        onClose?()
    }

    private func send(_ message: JSONValue) {
        conn.sendLine(message.encoded())
    }

    public func callAsync(_ method: String, _ params: JSONValue,
                          completion: @escaping (Result<JSONValue, RPCError>) -> Void) {
        lock.lock()
        let id = nextId
        nextId += 1
        pending[id] = completion
        lock.unlock()
        send(["id": .number(Double(id)), "method": .string(method), "params": params])
    }

    /// Blocking call with timeout. Callers are worker threads, never the read loop.
    public func call(_ method: String, _ params: JSONValue, timeout: TimeInterval = 30) throws -> JSONValue {
        let semaphore = DispatchSemaphore(value: 0)
        var outcome: Result<JSONValue, RPCError> = .failure(RPCError("timeout waiting for \(method)"))
        callAsync(method, params) { result in
            outcome = result
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + timeout)
        return try outcome.get()
    }

    public func close() {
        conn.close()
    }
}
