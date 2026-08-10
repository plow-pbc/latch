/**
 * Connect-time challenge/response — twin of DomoProtocol/Challenge.swift.
 * The domain-separation prefix means a device signature over a challenge can
 * never be mistaken for a signature over anything else (e.g. an intent).
 */
import crypto from "node:crypto";
import { KeyPair } from "./identity.js";

export const DeviceChallenge = {
  context: "domo-device-challenge:v1:",

  signingData(nonce: string): Buffer {
    return Buffer.from(this.context + nonce, "utf8");
  },

  sign(nonce: string, keyPair: KeyPair): string {
    return keyPair.sign(this.signingData(nonce)).toString("base64");
  },

  verify(nonce: string, signatureBase64: string, publicKeyBase64: string): boolean {
    const sig = Buffer.from(signatureBase64, "base64");
    return KeyPair.verify(sig, this.signingData(nonce), publicKeyBase64);
  },

  /** A fresh, single-use nonce for one connection attempt. */
  newNonce(): string {
    return crypto.randomUUID().toUpperCase() + crypto.randomUUID().toUpperCase();
  },
};
