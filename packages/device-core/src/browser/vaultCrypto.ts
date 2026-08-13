/**
 * The little bit of Bitwarden crypto the app needs to CREATE its one account on
 * its own vault: derive the keys from a password, wrap the account key, and talk
 * to a server whose certificate this machine minted for itself.
 *
 * Creating that account is all Domo does with it. Everything after — signing in,
 * changing the address or the password, reading what is stored — belongs to
 * Vaultwarden's own page and to the vault CLI, which already implement it.
 *
 * The password never leaves the machine; the server only ever sees a hash of a
 * hash of it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";

export const KDF_ITERATIONS = 600_000;

export interface VaultHttp {
  url: string;
  ca?: Buffer;
}

export function httpCa(caPath?: string): Buffer | undefined {
  return caPath && fs.existsSync(caPath) ? fs.readFileSync(caPath) : undefined;
}

/**
 * A vault that opened its port but never finishes a TLS handshake must not hang
 * the caller forever: `VaultServer.start()` is awaited before every credential
 * lookup. This bounds the wait; it does not by itself fit the relay's budget —
 * waiting for the port can precede it — which is why `browser_open` pays the
 * cold start behind a deferred handle.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export function send(
  http: VaultHttp,
  method: string,
  urlPath: string,
  body?: string,
  contentType = "application/json",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body);
    // A plain timer, not `req.setTimeout`: that one does not fire while a TLS
    // handshake is still hanging, which is exactly how a half-started vault
    // fails — the port answers, the handshake never finishes.
    let timer: NodeJS.Timeout;
    const settle = <T>(fn: (v: T) => void) => (value: T) => {
      clearTimeout(timer);
      fn(value);
    };
    const ok = settle(resolve);
    const fail = settle(reject);
    const req = https.request(
      `${http.url}${urlPath}`,
      {
        method,
        headers: {
          ...(payload ? { "Content-Type": contentType, "Content-Length": payload.length } : {}),
        },
        ...(http.ca ? { ca: http.ca } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.once("end", () =>
          ok({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    timer = setTimeout(() => {
      req.destroy(new Error(`the vault did not answer ${method} ${urlPath} in time`));
    }, REQUEST_TIMEOUT_MS);
    req.once("error", fail);
    req.end(payload);
  });
}

export const pbkdf2 = (pw: crypto.BinaryLike, salt: crypto.BinaryLike, iters: number, len: number) =>
  crypto.pbkdf2Sync(pw, salt, iters, len, "sha256");

/** HKDF-Expand (RFC 5869), single block — all a 32-byte key needs. */
export function hkdfExpand(prk: Buffer, info: string, len: number): Buffer {
  const h = crypto.createHmac("sha256", prk);
  h.update(Buffer.concat([Buffer.from(info, "utf8"), Buffer.from([1])]));
  return h.digest().subarray(0, len);
}

/** What the server stores: a hash of the key derived from the password. */
export function masterKeyAndHash(email: string, password: string) {
  const masterKey = pbkdf2(password, email.toLowerCase(), KDF_ITERATIONS, 32);
  return {
    masterKey,
    hash: pbkdf2(masterKey, password, 1, 32).toString("base64"),
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

