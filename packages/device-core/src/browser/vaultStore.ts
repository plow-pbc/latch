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
import { writeFileDurable } from "./durableFile.js";
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
   *
   * `expectedRevision` is the authoritative half of the stale-edit guarantee:
   * the caller's own staleEdit check is the fast path and the sentence the
   * owner reads, but it runs against a snapshot taken before an await — two
   * saves opened on the same revision can both pass it. The compare here runs
   * against the LIVE row inside one synchronous turn with the write, so
   * whichever save lands second is refused rather than silently winning (the
   * old server did this inside its write; this store must too).
   */
  upsert(cipher: Cipher, expectedRevision?: string): Cipher {
    const ciphers = this.readAll();
    const at = ciphers.findIndex((c) => c.id === (cipher.id ?? ""));
    if (at !== -1 && expectedRevision !== undefined && expectedRevision !== String(ciphers[at].revisionDate ?? "")) {
      throw new Error("this item changed somewhere else while you had it open; reopen it and make the change again");
    }
    // An edit whose row is GONE is the same race with a delete for a rival:
    // re-inserting it under the deleted id would quietly undo the delete.
    if (at === -1 && expectedRevision !== undefined) {
      throw new Error("this item was deleted while you had it open; the edit was not saved");
    }
    // The new revision must DIFFER from the old one, or the compare above (and
    // staleEdit) cannot tell the versions apart — and two writes inside one
    // millisecond otherwise mint the same ISO string. Clocks tie; nudge past.
    let revision = new Date().toISOString();
    if (at !== -1 && revision === String(ciphers[at].revisionDate ?? "")) {
      revision = new Date(Date.parse(revision) + 1).toISOString();
    }
    const stored: Cipher = {
      ...cipher,
      id: cipher.id ?? crypto.randomUUID(),
      revisionDate: revision,
    };
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
    // Atomic AND durable: a crash leaves the old file whole, and a power cut
    // cannot persist this file ahead of the key blob it depends on.
    writeFileDurable(this.file, body);
  }
}
