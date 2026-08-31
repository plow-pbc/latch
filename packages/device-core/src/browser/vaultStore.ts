/**
 * Where the vault's items live: one JSON file of Bitwarden-format ciphers.
 *
 * Every value in here is an EncString under the master key (vaultKeyStore.ts)
 * — the file holds ciphertext and structure, never a secret in the clear, so
 * its confidentiality floor is the key's, not the disk's. The Cipher shape is
 * exactly what vaultItems.ts encodes and decodes; migration from the old
 * Bitwarden server copies rows into here verbatim.
 *
 * This store is dumb on purpose: ids, revisions and atomic writes, nothing
 * else. What a field means, what is secret, and who may read it are decided in
 * vaultItems.ts / localVault.ts / brokerCli.ts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Cipher } from "./vaultItems.js";

const FILE_NAME = "items.json";

interface StoreFile {
  version: 1;
  ciphers: Cipher[];
}

export class VaultStore {
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, FILE_NAME);
  }

  /** Whether a store exists at all — what migration checks before running. */
  exists(): boolean {
    return fs.existsSync(this.file);
  }

  readAll(): Cipher[] {
    if (!fs.existsSync(this.file)) return [];
    const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoreFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.ciphers)) {
      throw new Error("the vault store file is not a shape this app knows");
    }
    return parsed.ciphers;
  }

  get(itemId: string): Cipher | null {
    return this.readAll().find((c) => c.id === itemId) ?? null;
  }

  /**
   * Write an item, assigning what the old server used to: an id for a new
   * item, and a fresh revision for every write (what staleEdit compares).
   * Returns the cipher as stored.
   */
  upsert(cipher: Cipher): Cipher {
    const stored: Cipher = {
      ...cipher,
      id: cipher.id ?? crypto.randomUUID(),
      revisionDate: new Date().toISOString(),
    };
    const ciphers = this.readAll();
    const at = ciphers.findIndex((c) => c.id === stored.id);
    if (at === -1) ciphers.push(stored);
    else ciphers[at] = stored;
    this.writeAll(ciphers);
    return stored;
  }

  /** Removal is final here — there is no server-side trash any more. */
  remove(itemId: string): void {
    const ciphers = this.readAll();
    const kept = ciphers.filter((c) => c.id !== itemId);
    if (kept.length !== ciphers.length) this.writeAll(kept);
  }

  /** The whole store at once — what migration writes, exactly once, last. */
  replaceAll(ciphers: Cipher[]): void {
    this.writeAll(ciphers);
  }

  private writeAll(ciphers: Cipher[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ version: 1, ciphers } satisfies StoreFile);
    // Atomic on the same filesystem: a crash leaves the old file whole.
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
