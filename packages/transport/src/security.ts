/**
 * Transport security seam — twin of DomoTransport/TransportSecurity.swift.
 * SPKI pin: base64(SHA-256(SubjectPublicKeyInfo)). Node can export the SPKI
 * directly from a certificate (no ASN.1 header reconstruction needed); the
 * value is interoperable with the Swift extractor and the OpenSSL recipe:
 *   openssl x509 -in cert.pem -pubkey -noout | openssl pkey -pubin -outform der \
 *     | openssl dgst -sha256 -binary | openssl base64
 */
import crypto from "node:crypto";

export interface SPKIPin {
  sha256Base64: string;
}

export function spkiPinOfDerCertificate(der: Buffer): string | null {
  try {
    const cert = new crypto.X509Certificate(der);
    const spki = cert.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    return crypto.createHash("sha256").update(spki).digest("base64");
  } catch {
    return null;
  }
}

/**
 * Decides whether a peer's presented certificate chain is trusted — called
 * during the TLS handshake INSTEAD of the system CA store when configured.
 */
export interface PeerTrustEvaluator {
  /** derChain is the peer's certificate chain, leaf first, DER-encoded. */
  evaluate(derChain: Buffer[]): boolean;
}

/**
 * Pins one or more SPKI hashes; trusts a peer only if its leaf certificate's
 * SPKI matches one — REPLACING the CA store. Fails CLOSED on an unparseable
 * leaf or empty chain.
 */
export class SPKIPinningEvaluator implements PeerTrustEvaluator {
  constructor(
    public readonly pins: SPKIPin[],
    private readonly spkiHashOfLeaf: (der: Buffer) => string | null = spkiPinOfDerCertificate,
  ) {}

  evaluate(derChain: Buffer[]): boolean {
    const leaf = derChain[0];
    if (!leaf) return false;
    const hash = this.spkiHashOfLeaf(leaf);
    if (hash === null) return false; // fail closed
    return this.pins.some((p) => p.sha256Base64 === hash);
  }
}

/** Local-loop stub: NO verification. Unix sockets have no peer certificate. */
export class InsecureLocalTrust implements PeerTrustEvaluator {
  evaluate(): boolean {
    return true;
  }
}
