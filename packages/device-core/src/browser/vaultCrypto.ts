/**
 * The vault's crypto primitives: Bitwarden's EncString format and the KDF that
 * unwraps a legacy account's key.
 *
 * The Bitwarden SERVER is gone, but this format is the live one — every field
 * of every item in the local store is an EncString (type 2: AES-256-CBC then
 * HMAC-SHA256), which is what made migration a verbatim copy. The KDF half
 * (`masterKeys`) exists for migration alone: it turns the old account's
 * password into the keys that unwrap its user key. Nothing here does I/O.
 */
import crypto from "node:crypto";

export const KDF_ITERATIONS = 600_000;

export const pbkdf2 = (pw: crypto.BinaryLike, salt: crypto.BinaryLike, iters: number, len: number) =>
  crypto.pbkdf2Sync(pw, salt, iters, len, "sha256");

/** HKDF-Expand (RFC 5869), single block — all a 32-byte key needs. */
export function hkdfExpand(prk: Buffer, info: string, len: number): Buffer {
  const h = crypto.createHmac("sha256", prk);
  h.update(Buffer.concat([Buffer.from(info, "utf8"), Buffer.from([1])]));
  return h.digest().subarray(0, len);
}

/** The keys a legacy account's password derives: the stretched halves are
 * what unwrap that account's user key. (The old server-auth hash — a
 * 1-iteration PBKDF2 of the password — died with the server; nothing here
 * authenticates to anything.) */
export function masterKeys(email: string, password: string) {
  const masterKey = pbkdf2(password, email.toLowerCase(), KDF_ITERATIONS, 32);
  return {
    stretchedEnc: hkdfExpand(masterKey, "enc", 32),
    stretchedMac: hkdfExpand(masterKey, "mac", 32),
  };
}

/** Bitwarden EncString type 2: AES-256-CBC then HMAC-SHA256. */
export function encString(plain: Buffer, encKey: Buffer, macKey: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", encKey, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = crypto.createHmac("sha256", macKey).update(Buffer.concat([iv, ct])).digest();
  return `2.${iv.toString("base64")}|${ct.toString("base64")}|${mac.toString("base64")}`;
}

export function decString(enc: string, encKey: Buffer, macKey: Buffer): Buffer {
  const dot = enc.indexOf(".");
  if (enc.slice(0, dot) !== "2") throw new Error(`unexpected EncString type ${enc.slice(0, dot)}`);
  const [ivB64, ctB64, macB64] = enc.slice(dot + 1).split("|");
  const iv = Buffer.from(ivB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const expect = crypto.createHmac("sha256", macKey).update(Buffer.concat([iv, ct])).digest();
  if (!crypto.timingSafeEqual(expect, Buffer.from(macB64, "base64"))) {
    throw new Error("EncString failed its integrity check");
  }
  const d = crypto.createDecipheriv("aes-256-cbc", encKey, iv);
  return Buffer.concat([d.update(ct), d.final()]);
}
