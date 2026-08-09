import Foundation

/// Security seam for the networked transport. NONE of this is wired into the
/// v1 Unix-socket path — locally, trust comes from filesystem permissions on
/// the `0700` runtime dir. These types exist so the TLS/WebSocket transport has
/// a defined place to plug in, and so the intended posture (self-signed certs +
/// key pinning, NOT public-CA trust) is expressed in code rather than only in
/// prose. See docs/network-security-runbook.md and DESIGN.md §8.

/// An SPKI public-key pin: base64(SHA-256(SubjectPublicKeyInfo)). Pin the KEY,
/// not the whole certificate, so the leaf can be rotated without re-pinning.
public struct SPKIPin: Equatable {
    public let sha256Base64: String
    public init(sha256Base64: String) { self.sha256Base64 = sha256Base64 }
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

/// Pins one or more SPKI hashes. Skeleton for the networked milestone: the SPKI
/// extraction from a DER certificate is a runbook task (it needs Security.framework
/// parsing), so this fails CLOSED until completed — safe to reference, unsafe to
/// rely on until the extractor is implemented.
public struct SPKIPinningEvaluator: PeerTrustEvaluator {
    public let pins: [SPKIPin]
    /// Extracts base64(SHA-256(SPKI)) from a DER-encoded certificate. Supplied
    /// by the transport once implemented (see runbook step "Pinning").
    public let spkiHashOfLeaf: ((Data) -> String?)?

    public init(pins: [SPKIPin], spkiHashOfLeaf: ((Data) -> String?)? = nil) {
        self.pins = pins
        self.spkiHashOfLeaf = spkiHashOfLeaf
    }

    public func evaluate(derChain: [Data]) -> Bool {
        guard let leaf = derChain.first, let extract = spkiHashOfLeaf,
              let hash = extract(leaf) else { return false } // fail closed
        return pins.contains(where: { $0.sha256Base64 == hash })
    }
}
