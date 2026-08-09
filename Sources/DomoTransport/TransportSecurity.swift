import Foundation
import CryptoKit
import Security

/// Security seam for the networked transport. NONE of this is wired into the
/// v1 Unix-socket path — locally, trust comes from filesystem permissions on
/// the `0700` runtime dir. These types exist so the TLS/WebSocket transport has
/// a defined place to plug in, and so the intended posture (self-signed certs +
/// key pinning, NOT public-CA trust) is expressed in code rather than only in
/// prose. See docs/network-security-runbook.md and DESIGN.md §8.

/// An SPKI public-key pin: base64(SHA-256(SubjectPublicKeyInfo)). Pin the KEY,
/// not the whole certificate, so the leaf can be rotated without re-pinning.
/// The value is interoperable with the canonical OpenSSL recipe:
///   openssl x509 -in cert.pem -pubkey -noout | openssl pkey -pubin -outform der \
///     | openssl dgst -sha256 -binary | openssl base64
public struct SPKIPin: Equatable {
    public let sha256Base64: String
    public init(sha256Base64: String) { self.sha256Base64 = sha256Base64 }

    /// Compute the pin for a DER-encoded certificate, or nil if the key type is
    /// unsupported / the cert can't be parsed.
    public init?(derCertificate: Data) {
        guard let hash = SPKIHash.base64(derCertificate: derCertificate) else { return nil }
        self.sha256Base64 = hash
    }
}

/// Extracts `base64(SHA-256(SubjectPublicKeyInfo))` from a DER certificate.
///
/// Security.framework hands back the *raw* public key (RSA PKCS#1 modulus/exp,
/// or the EC point), not the full SubjectPublicKeyInfo. To pin the SPKI — the
/// interoperable, rotation-tolerant unit — we prepend the fixed ASN.1
/// SPKI header for the key's (type, size), the same technique HPKP/TrustKit use.
public enum SPKIHash {
    public static func base64(derCertificate der: Data) -> String? {
        guard let cert = SecCertificateCreateWithData(nil, der as CFData),
              let key = leafKey(cert),
              let raw = SecKeyCopyExternalRepresentation(key, nil) as Data?,
              let header = spkiHeader(for: key) else { return nil }
        var spki = header
        spki.append(raw)
        return Data(SHA256.hash(data: spki)).base64EncodedString()
    }

    private static func leafKey(_ cert: SecCertificate) -> SecKey? {
        if #available(macOS 10.14, *) { return SecCertificateCopyKey(cert) }
        return nil
    }

    /// Fixed ASN.1 SubjectPublicKeyInfo headers by (key type, bits). These are
    /// constants of the algorithm, not of the specific key.
    private static func spkiHeader(for key: SecKey) -> Data? {
        guard let attrs = SecKeyCopyAttributes(key) as? [CFString: Any],
              let type = attrs[kSecAttrKeyType] as? String,
              let bits = attrs[kSecAttrKeySizeInBits] as? Int else { return nil }
        let ec = kSecAttrKeyTypeECSECPrimeRandom as String
        let rsa = kSecAttrKeyTypeRSA as String
        switch (type, bits) {
        case (ec, 256): return Data(ecP256)
        case (ec, 384): return Data(ecP384)
        case (rsa, 2048): return Data(rsa2048)
        case (rsa, 3072): return Data(rsa3072)
        case (rsa, 4096): return Data(rsa4096)
        default: return nil
        }
    }

    private static let ecP256: [UInt8] = [
        0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,
        0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00]
    private static let ecP384: [UInt8] = [
        0x30,0x76,0x30,0x10,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,
        0x06,0x05,0x2b,0x81,0x04,0x00,0x22,0x03,0x62,0x00]
    private static let rsa2048: [UInt8] = [
        0x30,0x82,0x01,0x22,0x30,0x0d,0x06,0x09,0x2a,0x86,0x48,0x86,0xf7,
        0x0d,0x01,0x01,0x01,0x05,0x00,0x03,0x82,0x01,0x0f,0x00]
    private static let rsa3072: [UInt8] = [
        0x30,0x82,0x01,0xa2,0x30,0x0d,0x06,0x09,0x2a,0x86,0x48,0x86,0xf7,
        0x0d,0x01,0x01,0x01,0x05,0x00,0x03,0x82,0x01,0x8f,0x00]
    private static let rsa4096: [UInt8] = [
        0x30,0x82,0x02,0x22,0x30,0x0d,0x06,0x09,0x2a,0x86,0x48,0x86,0xf7,
        0x0d,0x01,0x01,0x01,0x05,0x00,0x03,0x82,0x02,0x0f,0x00]
}

/// Decides whether a peer's presented certificate chain is trusted. The
/// networked transport calls this during the TLS handshake INSTEAD of trusting
/// the system CA store — that is what makes self-signed + pinning the intended
/// production posture. The core security (signed intents, Noise E2E) does not
/// depend on this; it is transport hardening / anti-impersonation.
public protocol PeerTrustEvaluator {
    /// `derChain` is the peer's certificate chain, leaf first, DER-encoded.
    /// Return true only if it satisfies the configured pin(s).
    func evaluate(derChain: [Data]) -> Bool
}

/// v1 / local-loop stub: performs NO verification. Unix sockets have no peer
/// certificate; trust is the filesystem. The networked transport MUST use
/// `SPKIPinningEvaluator` instead — this type is named to be conspicuous in
/// review so it can never be shipped over a real network by accident.
public struct InsecureLocalTrust: PeerTrustEvaluator {
    public init() {}
    public func evaluate(derChain: [Data]) -> Bool { true }
}

/// Pins one or more SPKI hashes and trusts a peer only if its leaf certificate's
/// SPKI matches one of them — REPLACING the system CA store. `spkiHashOfLeaf`
/// defaults to the real `SPKIHash` extractor (Phase 2); the closure stays
/// injectable so tests can force specific values. Fails CLOSED: an unparseable
/// leaf or an empty chain is rejected.
public struct SPKIPinningEvaluator: PeerTrustEvaluator {
    public let pins: [SPKIPin]
    /// Extracts base64(SHA-256(SPKI)) from a DER-encoded certificate.
    public let spkiHashOfLeaf: (Data) -> String?

    public init(pins: [SPKIPin], spkiHashOfLeaf: @escaping (Data) -> String? = { SPKIHash.base64(derCertificate: $0) }) {
        self.pins = pins
        self.spkiHashOfLeaf = spkiHashOfLeaf
    }

    public func evaluate(derChain: [Data]) -> Bool {
        guard let leaf = derChain.first, let hash = spkiHashOfLeaf(leaf) else { return false } // fail closed
        return pins.contains(where: { $0.sha256Base64 == hash })
    }
}
