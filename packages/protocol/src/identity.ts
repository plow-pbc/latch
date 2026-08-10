/**
 * Ed25519 keypair with a stable fingerprint identity — twin of
 * DomoProtocol/Identity.swift. Node's crypto exposes Ed25519 through
 * DER-wrapped keys; CryptoKit uses raw 32-byte representations. The fixed
 * DER prefixes below convert between them (constants of the algorithm).
 * Ed25519 signatures are deterministic (RFC 8032), so both implementations
 * produce byte-identical signatures — asserted by fixtures/identity.json.
 */
import crypto from "node:crypto";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function privateKeyFromSeed(seed: Buffer): crypto.KeyObject {
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyFromRaw(raw: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export class KeyPair {
  private readonly privateKey: crypto.KeyObject;
  private readonly seed: Buffer;
  readonly publicKeyRaw: Buffer;

  constructor(seed?: Buffer) {
    this.seed = seed ?? crypto.randomBytes(32);
    if (this.seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
    this.privateKey = privateKeyFromSeed(this.seed);
    const spki = crypto
      .createPublicKey(this.privateKey)
      .export({ format: "der", type: "spki" }) as Buffer;
    this.publicKeyRaw = spki.subarray(SPKI_ED25519_PREFIX.length);
  }

  static fromRawRepresentation(raw: Buffer): KeyPair {
    return new KeyPair(raw);
  }

  get publicKeyBase64(): string {
    return this.publicKeyRaw.toString("base64");
  }

  get privateKeyBase64(): string {
    return this.seed.toString("base64");
  }

  /** Stable short identity derived from the public key. */
  get fingerprint(): string {
    return KeyPair.fingerprintOfPublicKeyBase64(this.publicKeyBase64);
  }

  static fingerprintOfPublicKeyBase64(publicKeyBase64: string): string {
    return crypto
      .createHash("sha256")
      .update(Buffer.from(publicKeyBase64, "utf8"))
      .digest()
      .subarray(0, 8)
      .toString("hex");
  }

  sign(data: Buffer): Buffer {
    return crypto.sign(null, data, this.privateKey);
  }

  static verify(signature: Buffer, data: Buffer, publicKeyBase64: string): boolean {
    let key: crypto.KeyObject;
    try {
      const raw = Buffer.from(publicKeyBase64, "base64");
      if (raw.length !== 32) return false;
      key = publicKeyFromRaw(raw);
    } catch {
      return false;
    }
    try {
      return crypto.verify(null, data, key, signature);
    } catch {
      return false;
    }
  }
}

export const Hashing = {
  sha256Hex(data: Buffer): string {
    return crypto.createHash("sha256").update(data).digest("hex");
  },
};
