/**
 * End-to-end encrypted, mutually-authenticated agent↔device channel — twin of
 * DomoTransport/E2EChannel.swift (station-to-station / Noise-XX-equivalent).
 * The broker relays handshake and sealed frames blindly.
 *
 * Primitives (all node:crypto, matching CryptoKit): X25519 ECDH,
 * Ed25519-signed ephemerals, HKDF-SHA256 key split, ChaCha20-Poly1305 AEAD.
 * Frame layout: nonce(12) || ciphertext || tag(16) — CryptoKit's `combined`.
 * Key schedule is golden-tested against fixtures/channel.json.
 */
import crypto from "node:crypto";
import { canonicalBytes, JSONValue, jv, KeyPair, parseJSON } from "@domo/protocol";

const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const INIT_CONTEXT = "domo-e2e-init:v1:";
const RESP_CONTEXT = "domo-e2e-resp:v1:";
const HKDF_INFO_I2R = Buffer.from("domo-e2e:i2r", "utf8");
const HKDF_INFO_R2I = Buffer.from("domo-e2e:r2i", "utf8");

export class HandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandshakeError";
  }
}

function x25519FromSeed(seed: Buffer): crypto.KeyObject {
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function x25519PublicRaw(privateKey: crypto.KeyObject): Buffer {
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(SPKI_X25519_PREFIX.length);
}

function x25519PublicFromRaw(raw: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_X25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export type ChannelRole = "initiator" | "responder";

export class E2EChannel {
  private readonly ephemeral: crypto.KeyObject;
  private readonly ephemeralPublicRaw: Buffer;
  private sendKey: Buffer | null = null;
  private recvKey: Buffer | null = null;

  private constructor(
    private readonly role: ChannelRole,
    private readonly identity: KeyPair,
    private readonly expectedPeerIdentity: string,
    ephemeralSeed?: Buffer,
  ) {
    this.ephemeral = x25519FromSeed(ephemeralSeed ?? crypto.randomBytes(32));
    this.ephemeralPublicRaw = x25519PublicRaw(this.ephemeral);
  }

  get isEstablished(): boolean {
    return this.sendKey !== null && this.recvKey !== null;
  }

  /** Agent side: returns the (not yet established) channel + msg1 to relay. */
  static initiate(
    identity: KeyPair,
    peerIdentityPublicKeyBase64: string,
    ephemeralSeed?: Buffer,
  ): { channel: E2EChannel; msg1: Buffer } {
    const channel = new E2EChannel("initiator", identity, peerIdentityPublicKeyBase64, ephemeralSeed);
    const ePub = channel.ephemeralPublicRaw;
    const sig = identity.sign(Buffer.concat([Buffer.from(INIT_CONTEXT, "utf8"), ePub]));
    const msg: JSONValue = {
      e: ePub.toString("base64"),
      id: identity.publicKeyBase64,
      sig: sig.toString("base64"),
    };
    return { channel, msg1: canonicalBytes(msg) };
  }

  /** Device side: verifies msg1, derives keys, returns established channel + msg2. */
  static respond(
    identity: KeyPair,
    expectedPeerIdentityPublicKeyBase64: string,
    msg1: Buffer,
    ephemeralSeed?: Buffer,
  ): { channel: E2EChannel; msg2: Buffer } {
    const channel = new E2EChannel(
      "responder",
      identity,
      expectedPeerIdentityPublicKeyBase64,
      ephemeralSeed,
    );
    let m;
    try {
      m = jv(parseJSON(msg1));
    } catch {
      throw new HandshakeError("malformed handshake msg1");
    }
    const ePeerB64 = m.get("e").str;
    const peerId = m.get("id").str;
    const sigB64 = m.get("sig").str;
    if (ePeerB64 === null || peerId === null || sigB64 === null) {
      throw new HandshakeError("malformed handshake msg1");
    }
    const ePeer = Buffer.from(ePeerB64, "base64");
    // The initiator must be exactly the pinned identity, and its ephemeral key
    // must be signed by that identity — a MITM broker can't forge this.
    if (peerId !== expectedPeerIdentityPublicKeyBase64) {
      throw new HandshakeError("unexpected peer identity");
    }
    const signedData = Buffer.concat([Buffer.from(INIT_CONTEXT, "utf8"), ePeer]);
    if (!KeyPair.verify(Buffer.from(sigB64, "base64"), signedData, peerId)) {
      throw new HandshakeError("bad initiator signature");
    }
    channel.deriveKeys(ePeer);

    const ePub = channel.ephemeralPublicRaw;
    const sigB = identity.sign(Buffer.concat([Buffer.from(RESP_CONTEXT, "utf8"), ePub, ePeer]));
    const msg2: JSONValue = {
      e: ePub.toString("base64"),
      id: identity.publicKeyBase64,
      sig: sigB.toString("base64"),
    };
    return { channel, msg2: canonicalBytes(msg2) };
  }

  /** Agent side: complete the handshake with the device's response. */
  receiveResponse(msg2: Buffer): void {
    if (this.role !== "initiator") throw new HandshakeError("wrong role for receiveResponse");
    let m;
    try {
      m = jv(parseJSON(msg2));
    } catch {
      throw new HandshakeError("malformed handshake msg2");
    }
    const ePeerB64 = m.get("e").str;
    const peerId = m.get("id").str;
    const sigB64 = m.get("sig").str;
    if (ePeerB64 === null || peerId === null || sigB64 === null) {
      throw new HandshakeError("malformed handshake msg2");
    }
    const ePeer = Buffer.from(ePeerB64, "base64");
    if (peerId !== this.expectedPeerIdentity) {
      throw new HandshakeError("unexpected peer identity");
    }
    const signedData = Buffer.concat([
      Buffer.from(RESP_CONTEXT, "utf8"),
      ePeer,
      this.ephemeralPublicRaw,
    ]);
    if (!KeyPair.verify(Buffer.from(sigB64, "base64"), signedData, peerId)) {
      throw new HandshakeError("bad responder signature");
    }
    this.deriveKeys(ePeer);
  }

  private deriveKeys(peerEphemeral: Buffer): void {
    let shared: Buffer;
    try {
      shared = crypto.diffieHellman({
        privateKey: this.ephemeral,
        publicKey: x25519PublicFromRaw(peerEphemeral),
      });
    } catch {
      throw new HandshakeError("key agreement failed");
    }
    // Salt binds both ephemerals; distinct info labels split the secret into
    // two directional keys so the directions never share a keystream.
    const myEph = this.ephemeralPublicRaw;
    const salt =
      this.role === "initiator"
        ? Buffer.concat([myEph, peerEphemeral])
        : Buffer.concat([peerEphemeral, myEph]);
    const i2r = Buffer.from(crypto.hkdfSync("sha256", shared, salt, HKDF_INFO_I2R, 32));
    const r2i = Buffer.from(crypto.hkdfSync("sha256", shared, salt, HKDF_INFO_R2I, 32));
    if (this.role === "initiator") {
      this.sendKey = i2r;
      this.recvKey = r2i;
    } else {
      this.sendKey = r2i;
      this.recvKey = i2r;
    }
  }

  /** Seal a payload for the peer: nonce || ciphertext || tag. */
  seal(plaintext: Buffer, nonce?: Buffer): Buffer {
    if (!this.sendKey) throw new HandshakeError("channel not established");
    return sealWithKey(this.sendKey, plaintext, nonce);
  }

  /** Open a sealed frame; throws if the relay tampered with any byte. */
  open(frame: Buffer): Buffer {
    if (!this.recvKey) throw new HandshakeError("channel not established");
    return openWithKey(this.recvKey, frame);
  }
}

export function sealWithKey(key: Buffer, plaintext: Buffer, nonce?: Buffer): Buffer {
  const n = nonce ?? crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("chacha20-poly1305", key, n, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([n, ct, cipher.getAuthTag()]);
}

export function openWithKey(key: Buffer, frame: Buffer): Buffer {
  if (frame.length < 12 + 16) throw new HandshakeError("frame too short");
  const n = frame.subarray(0, 12);
  const ct = frame.subarray(12, frame.length - 16);
  const tag = frame.subarray(frame.length - 16);
  const decipher = crypto.createDecipheriv("chacha20-poly1305", key, n, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new HandshakeError("frame authentication failed");
  }
}
