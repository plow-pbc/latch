/**
 * The little bit of Bitwarden crypto the app needs to own an account on its own
 * vault: derive the keys from a password, wrap and unwrap the account key, and
 * talk to a server whose certificate this machine minted for itself.
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
  token?: string;
}

export function httpCa(caPath?: string): Buffer | undefined {
  return caPath && fs.existsSync(caPath) ? fs.readFileSync(caPath) : undefined;
}

export function send(
  http: VaultHttp,
  method: string,
  urlPath: string,
  body?: string,
  contentType = "application/json",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body);
    const req = https.request(
      `${http.url}${urlPath}`,
      {
        method,
        headers: {
          ...(payload ? { "Content-Type": contentType, "Content-Length": payload.length } : {}),
          ...(http.token ? { Authorization: `Bearer ${http.token}` } : {}),
        },
        ...(http.ca ? { ca: http.ca } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.once("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.once("error", reject);
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

/** Sign in and unwrap the account key, which everything else is built on. */
export async function signIn(http: VaultHttp, email: string, password: string) {
  const { hash, stretchedEnc, stretchedMac } = masterKeyAndHash(email, password);
  const form = new URLSearchParams({
    grant_type: "password",
    username: email,
    password: hash,
    scope: "api offline_access",
    client_id: "cli",
    deviceType: "8",
    deviceIdentifier: crypto.randomUUID(),
    deviceName: "domo",
  }).toString();
  const res = await send(http, "POST", "/identity/connect/token", form, "application/x-www-form-urlencoded");
  if (res.status !== 200) throw new Error(`vault sign-in failed (HTTP ${res.status})`);
  const t = JSON.parse(res.body) as { access_token: string; Key: string };
  http.token = t.access_token;
  return { userKey: decString(t.Key, stretchedEnc, stretchedMac), passwordHash: hash };
}
