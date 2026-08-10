import Foundation

/// The single thing a human ever copies to connect. Bundles everything a device
/// or an agent needs to reach a broker — URL, certificate pin, and (for agents)
/// the token — so nobody hand-copies keys/pins/tokens separately.
///
/// Three interchangeable text forms, all parsed by `parse(_:)`:
///   - compact:   `domo1.<base64url(json)>`         ← the copy-paste artifact
///   - deep link: `domo://connect?c=<base64url(json)>` ← for the app URL scheme
///   - bare URL:  `ws://host:port/` or `wss://…`     ← convenience, no pin/token
///
/// Security note: a device connection string carries only public values (URL +
/// pin) and is safe to show/QR. An *agent* connection string also carries the
/// token, which is a secret — deliver it in-app, never in a logged URL or email.
public struct DomoConnection: Equatable {
    /// Broker endpoint the client dials (agent endpoint for agents, device
    /// endpoint for the Mac).
    public var url: String
    /// SPKI pin (base64 SHA-256) for the broker cert. nil ⇒ plain `ws://`.
    public var pin: String?
    /// Agent token. Present only in an agent connection string.
    public var token: String?
    /// Optional human label (e.g. the broker or agent name).
    public var name: String?
    /// Whether a device connecting here must run the enrollment challenge
    /// (i.e. the broker was started with --require-enrollment). The broker knows
    /// this when it issues the string, so the device need not guess. Irrelevant
    /// for agent strings (agents authenticate with the token).
    public var authenticate: Bool

    public init(url: String, pin: String? = nil, token: String? = nil,
                name: String? = nil, authenticate: Bool = false) {
        self.url = url
        self.pin = pin
        self.token = token
        self.name = name
        self.authenticate = authenticate
    }

    public var isSecure: Bool { url.hasPrefix("wss://") }
    public var isNetworked: Bool { url.hasPrefix("ws://") || url.hasPrefix("wss://") }

    private struct Payload: Codable {
        var u: String
        var pin: String?
        var t: String?
        var n: String?
        var a: Bool?
    }

    private static let compactPrefix = "domo1."

    private var payloadJSON: Data {
        let payload = Payload(u: url, pin: pin, t: token, n: name, a: authenticate ? true : nil)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(payload)) ?? Data()
    }

    /// The compact copy-paste artifact: `domo1.<base64url(json)>`.
    public func compactString() -> String {
        Self.compactPrefix + Base64URL.encode(payloadJSON)
    }

    /// The deep link form for the app's `domo://` URL scheme.
    public func deepLink() -> String {
        "domo://connect?c=" + Base64URL.encode(payloadJSON)
    }

    /// Parse any accepted form. Returns nil if it isn't a recognizable
    /// connection string / broker URL.
    public static func parse(_ raw: String) -> DomoConnection? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }

        if text.hasPrefix(compactPrefix) {
            return decodePayload(String(text.dropFirst(compactPrefix.count)))
        }
        if text.hasPrefix("domo://") {
            guard let comps = URLComponents(string: text),
                  let c = comps.queryItems?.first(where: { $0.name == "c" })?.value else { return nil }
            return decodePayload(c)
        }
        if text.hasPrefix("ws://") || text.hasPrefix("wss://") {
            return DomoConnection(url: text)
        }
        return nil
    }

    private static func decodePayload(_ b64: String) -> DomoConnection? {
        guard let data = Base64URL.decode(b64),
              let payload = try? JSONDecoder().decode(Payload.self, from: data) else { return nil }
        return DomoConnection(url: payload.u, pin: payload.pin, token: payload.t,
                              name: payload.n, authenticate: payload.a ?? false)
    }
}

/// Base64URL without padding — safe inside URLs and easy to paste.
public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ string: String) -> Data? {
        var s = string.replacingOccurrences(of: "-", with: "+")
                      .replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s.append("=") }
        return Data(base64Encoded: s)
    }
}
