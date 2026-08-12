/**
 * First run of a vault that lives on this Mac: create the account the broker
 * signs in as, and leave its password where the broker already looks.
 *
 * The vault clients have no `register`, and the endpoint we used to pair a
 * machine against belonged to the server we hosted — neither exists here. So
 * the app does it itself, with the same scheme the official clients use: the
 * password never leaves this machine, the server only ever stores a hash of a
 * hash, and the key that protects the vault's contents is wrapped with a key
 * stretched from that password.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import { VaultSecretStore, VaultAccount } from "./vaultSecretStore.js";

const KDF_ITERATIONS = 600_000;

const pbkdf2 = (pw: crypto.BinaryLike, salt: crypto.BinaryLike, iters: number, len: number) =>
  crypto.pbkdf2Sync(pw, salt, iters, len, "sha256");

/** HKDF-Expand (RFC 5869), single block — all a 32-byte key needs. */
function hkdfExpand(prk: Buffer, info: string, len: number): Buffer {
  const h = crypto.createHmac("sha256", prk);
  h.update(Buffer.concat([Buffer.from(info, "utf8"), Buffer.from([1])]));
  return h.digest().subarray(0, len);
}

/** Bitwarden EncString type 2: AES-256-CBC then HMAC-SHA256, base64 pieces. */
function encString(plain: Buffer, encKey: Buffer, macKey: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", encKey, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = crypto.createHmac("sha256", macKey).update(Buffer.concat([iv, ct])).digest();
  return `2.${iv.toString("base64")}|${ct.toString("base64")}|${mac.toString("base64")}`;
}

/**
 * POST JSON to our own vault. `fetch` cannot be told to trust one certificate,
 * and the vault's cert is the one this machine minted for itself — so use the
 * https client, which can, rather than disabling verification globally.
 */
function post(url: string, body: unknown, caPath?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": payload.length },
        ...(caPath && fs.existsSync(caPath) ? { ca: fs.readFileSync(caPath) } : {}),
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.once("error", reject);
    req.end(payload);
  });
}

/** The one vault account this machine uses, or null before it has one. */
export function vaultAccount(storeDir: string): VaultAccount | null {
  return new VaultSecretStore(storeDir).read();
}

/** True once this machine has an account it can sign into the vault with. */
export function vaultAccountExists(storeDir: string): boolean {
  return vaultAccount(storeDir) !== null;
}

/**
 * Create this machine's agent account on a vault that has just started, and
 * record it for the broker. Idempotent: does nothing once an account exists.
 * Returns the account address, or null when one was already there.
 */
export async function ensureVaultAccount(
  vaultUrl: string,
  storeDir: string,
  person: string,
  caPath?: string,
): Promise<string | null> {
  const store = new VaultSecretStore(storeDir);
  if (store.read()) return null;

  // One account for this machine: the human signs into it on the vault's page
  // and the agent signs into it to read what is there.
  const email = `${person.split("@")[0]}-${crypto.randomBytes(3).toString("hex")}@local`;
  const password = crypto.randomBytes(32).toString("base64url");

  const masterKey = pbkdf2(password, email.toLowerCase(), KDF_ITERATIONS, 32);
  const masterPasswordHash = pbkdf2(masterKey, password, 1, 32).toString("base64");
  const userKey = crypto.randomBytes(64);
  const protectedKey = encString(
    userKey,
    hkdfExpand(masterKey, "enc", 32),
    hkdfExpand(masterKey, "mac", 32),
  );
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const encryptedPrivateKey = encString(
    privateKey.export({ type: "pkcs8", format: "der" }),
    userKey.subarray(0, 32),
    userKey.subarray(32),
  );

  const status = await post(
    `${vaultUrl}/identity/accounts/register`,
    {
      email,
      name: email.split("@")[0],
      masterPasswordHash,
      masterPasswordHint: null,
      key: protectedKey,
      kdf: 0,
      kdfIterations: KDF_ITERATIONS,
      keys: { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), encryptedPrivateKey },
    },
    caPath,
  );
  if (status < 200 || status >= 300) {
    throw new Error(`vault refused to create this machine's account (HTTP ${status})`);
  }

  // Written only after the account exists, so a failed run retries cleanly
  // rather than leaving a password for an account that was never created.
  store.write({ email, password });
  return email;
}
