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
import path from "node:path";
import { encString, httpCa, masterKeyAndHash, send, KDF_ITERATIONS } from "./vaultCrypto.js";
import { VaultSecretStore, VaultAccount } from "./vaultSecretStore.js";



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

  // A vault with a database but no stored account means the account was lost,
  // not that this is a first run. Registering a second one here would leave
  // whatever is already in there unreachable, with nobody told — so stop.
  if (fs.existsSync(path.join(storeDir, "db.sqlite3"))) {
    throw new Error(
      "this vault already has data but its account is missing — refusing to create a second one",
    );
  }

  // One account for this machine: the human signs into it on the vault's page
  // and the agent signs into it to read what is there.
  const email = `${person.split("@")[0]}-${crypto.randomBytes(3).toString("hex")}@local`;
  const password = crypto.randomBytes(32).toString("base64url");

  const derived = masterKeyAndHash(email, password);
  const userKey = crypto.randomBytes(64);
  const protectedKey = encString(userKey, derived.stretchedEnc, derived.stretchedMac);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const encryptedPrivateKey = encString(
    privateKey.export({ type: "pkcs8", format: "der" }),
    userKey.subarray(0, 32),
    userKey.subarray(32),
  );

  const res = await send(
    { url: vaultUrl, ca: httpCa(caPath) },
    "POST",
    "/identity/accounts/register",
    JSON.stringify({
      email,
      name: email.split("@")[0],
      masterPasswordHash: derived.hash,
      masterPasswordHint: null,
      key: protectedKey,
      kdf: 0,
      kdfIterations: KDF_ITERATIONS,
      keys: { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), encryptedPrivateKey },
    }),
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`vault refused to create this machine's account (HTTP ${res.status})`);
  }

  // Written only after the account exists, so a failed run retries cleanly
  // rather than leaving a password for an account that was never created.
  store.write({ email, password });
  return email;
}
