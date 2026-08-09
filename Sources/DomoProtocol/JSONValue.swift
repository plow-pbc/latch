import Foundation

/// A general JSON value used for wire messages (MCP JSON-RPC, broker/device RPC)
/// and tool schemas. Codable, order-independent equality, canonical encoding.
public enum JSONValue: Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

public extension JSONValue {
    var str: String? { if case .string(let s) = self { return s }; return nil }
    var num: Double? { if case .number(let n) = self { return n }; return nil }
    var int: Int? { num.map { Int($0) } }
    var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    var arr: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    var obj: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    var isNull: Bool { self == .null }

    subscript(key: String) -> JSONValue {
        if case .object(let o) = self, let v = o[key] { return v }
        return .null
    }

    subscript(index: Int) -> JSONValue {
        if case .array(let a) = self, index >= 0, index < a.count { return a[index] }
        return .null
    }

    static func parse(_ data: Data) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: data)
    }

    static func parse(_ string: String) throws -> JSONValue {
        try parse(Data(string.utf8))
    }

    func encoded() -> Data {
        Canonical.encode(self)
    }

    func jsonString() -> String {
        String(data: encoded(), encoding: .utf8) ?? "null"
    }

    /// Decode a Codable type out of this JSON subtree.
    func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder.domo.decode(T.self, from: encoded())
    }

    /// Encode a Codable value into a JSONValue.
    static func from<T: Encodable>(_ value: T) -> JSONValue {
        (try? JSONValue.parse(Canonical.encode(value))) ?? .null
    }
}

extension JSONValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByStringLiteral,
    ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral {
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(uniqueKeysWithValues: elements))
    }
}

/// Canonical JSON encoding: sorted keys, ISO-8601 dates, no pretty printing.
/// Used for signing payloads and rule keys, so determinism matters.
public enum Canonical {
    public static func encode<T: Encodable>(_ value: T) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(value) else {
            return Data("null".utf8)
        }
        return data
    }
}

public extension JSONDecoder {
    static var domo: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}
