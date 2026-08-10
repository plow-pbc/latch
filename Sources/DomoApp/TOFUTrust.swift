import Foundation
import DomoProtocol
import DomoTransport

/// Trust-on-first-use for the broker's self-signed certificate. The first time
/// the app connects to a broker URL it records (pins) that cert's SPKI; on every
/// later connect it requires the same key. Same model as SSH known_hosts: a
/// silent auto-trust on first contact, then hard pinning that catches a later
/// man-in-the-middle. An explicit pin (from a pasted connection string) bypasses
/// this and is enforced directly instead.
final class KnownBrokers {
    private let url: URL
    private let lock = NSLock()
    private var pins: [String: String]   // broker URL -> SPKI base64

    init(url: URL) {
        self.url = url
        if let data = try? Data(contentsOf: url),
           let stored = try? JSONDecoder().decode([String: String].self, from: data) {
            pins = stored
        } else {
            pins = [:]
        }
    }

    func pin(for brokerURL: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return pins[brokerURL]
    }

    func record(_ spki: String, for brokerURL: String) {
        lock.lock()
        pins[brokerURL] = spki
        let snapshot = pins
        lock.unlock()
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? enc.encode(snapshot).write(to: url)
    }

    /// Forget the pin for a broker (e.g. to re-trust after a deliberate cert change).
    func forget(_ brokerURL: String) {
        lock.lock()
        pins.removeValue(forKey: brokerURL)
        let snapshot = pins
        lock.unlock()
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? enc.encode(snapshot).write(to: url)
    }
}

struct TOFUTrust: PeerTrustEvaluator {
    let brokerURL: String
    let store: KnownBrokers

    func evaluate(derChain: [Data]) -> Bool {
        guard let leaf = derChain.first, let spki = SPKIHash.base64(derCertificate: leaf) else {
            return false   // unparseable cert: fail closed
        }
        if let known = store.pin(for: brokerURL) {
            return known == spki   // subsequent connect: must match
        }
        store.record(spki, for: brokerURL)   // first use: trust and remember
        return true
    }
}
