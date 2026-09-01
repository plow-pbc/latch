/**
 * The vault, owner-side: what the Vault tab talks to.
 *
 * Same surface VaultClient had (list / read / reveal / totp / save / remove,
 * plus the reprompt hook), with the server gone: items live in the local
 * store (vaultStore.ts), the master key in the key store (vaultKeyStore.ts),
 * and all of the item semantics — what is secret, stale-edit refusal, URL
 * checking — stay in vaultItems.ts where they always were.
 *
 * The agent-side face is BrokerCore, where a release is bound to the page on
 * screen and audited. This is the owner's own screen.
 */
import fs from "node:fs";
import path from "node:path";
import {
  Cipher,
  checkedUrls,
  staleEdit,
  decryptField,
  decryptItem,
  decryptSummary,
  splitKey,
  encryptCipher,
  TYPE_CODE,
  TYPE_NAME,
  VaultItem,
  VaultItemInput,
  VaultItemSummary,
  VaultKey,
} from "./vaultItems.js";
import { totpCode, totpKeyEquals, totpParams, type TotpCode } from "./vaultTotp.js";
import { VaultKeyStore } from "./vaultKeyStore.js";
import { VaultStore } from "./vaultStore.js";
import { openVaultKey } from "./vaultMigrate.js";

export class LocalVault {
  private readonly store: VaultStore;

  constructor(
    private readonly dir: string,
    private readonly keyStore: VaultKeyStore,
    /** One line per value the owner asked to see. Never the value. */
    private readonly auditPath?: string,
  ) {
    this.store = new VaultStore(dir);
  }

  /**
   * The key, via the shared open path (openVaultKey: migrate a legacy vault,
   * mint for a genuinely fresh one, refuse a locked one). Run per call rather
   * than cached: the key store is cheap to read, and a Keychain that unlocks
   * mid-session should start working without a restart.
   */
  private open(): VaultKey {
    return splitKey(openVaultKey(this.dir, this.keyStore, this.store));
  }

  /**
   * Prove the owner is here, for an item marked `reprompt`. The vault's own
   * clients ask for the master password again; this app has no password to ask
   * for, so the honest equivalent is the Mac asking who is at the keyboard.
   * Set by whoever can do that; until then, such an item stays shut.
   */
  onReprompt: (() => Promise<boolean>) | null = null;

  /** Refuse an item that asks for the owner, unless the owner answers. */
  private async cleared(cipher: Cipher): Promise<Cipher> {
    if (!cipher.reprompt) return cipher;
    if (this.onReprompt && (await this.onReprompt())) return cipher;
    throw new Error("this item asks for you to confirm it is you, and that was not confirmed");
  }

  private cipher(itemId: string): Cipher {
    const found = this.store.get(itemId);
    if (!found) throw new Error("no such item in the vault");
    return found;
  }

  /** Everything in the vault, in the clear except the secrets themselves. */
  async list(): Promise<VaultItemSummary[]> {
    const key = this.open();
    // An item of a type this app cannot hold makes the listing fail, and the
    // tab says so. Skipping it quietly was worse: a vault holding only such an
    // item read as an empty vault.
    return this.store.readAll().map((c) => decryptSummary(c, key));
  }

  /** One whole item, with its secret values null — what a form is filled from. */
  async read(itemId: string): Promise<VaultItem> {
    const key = this.open();
    return decryptItem(await this.cleared(this.cipher(itemId)), key);
  }

  /**
   * One value, because the owner asked to see it on their own screen. There is
   * no page to bind it to, so the audit line says so rather than naming a site.
   */
  async reveal(itemId: string, field: string): Promise<string> {
    const key = this.open();
    const value = decryptField(await this.cleared(this.cipher(itemId)), key, field);
    this.audit(itemId, field, "SHOWN in app");
    return value;
  }

  /** The code this item's authenticator key is showing right now. */
  async totp(itemId: string): Promise<TotpCode> {
    const key = this.open();
    const stored = decryptField(await this.cleared(this.cipher(itemId)), key, "totp");
    const code = totpCode(stored);
    // What this line can honestly claim is the ACCESS: the key was decrypted
    // here and a code derived from it. Whether the window ever put those
    // digits on screen is not knowable from here.
    this.audit(itemId, "totp", "CODE READ in app");
    return code;
  }

  /**
   * Whether the supplied secrets differ from what a login stores — the
   * password-import update check. The stored values are decrypted HERE and
   * compared; only booleans (and the item's revision, for the later save)
   * leave, so no audit line claims a value was shown, because none was.
   *
   * An empty candidate is "the export did not carry one", never a removal:
   * Chrome's CSV has no TOTP column, and that must not read as every stored
   * key having changed. A TOTP compare is by the KEY the strings decode to —
   * the bare base32 and its otpauth:// spelling are the same key.
   *
   * Deliberately not behind the reprompt gate: nothing is shown or changed,
   * and the one bit this leaks (that a value the owner is already holding in
   * an export matches) is theirs. The UPDATE that may follow goes through
   * save, which asks.
   */
  async secretsDiffer(
    itemId: string,
    candidate: { password: string; totp: string },
  ): Promise<{ password: boolean; totp: boolean; revision: string }> {
    const key = this.open();
    const cipher = this.cipher(itemId);
    const stored = (field: string): string => {
      try {
        return decryptField(cipher, key, field);
      } catch {
        return ""; // the item holds no such value
      }
    };
    return {
      password: candidate.password.trim() !== "" && stored("password") !== candidate.password,
      totp: candidate.totp.trim() !== "" && !totpKeyEquals(stored("totp"), candidate.totp),
      revision: String(cipher.revisionDate ?? ""),
    };
  }

  /** Create an item, or change one that is already there. */
  async save(input: VaultItemInput): Promise<{ id: string; title: string }> {
    const key = this.open();
    const existing = input.itemId ? await this.cleared(this.cipher(input.itemId)) : null;
    const type = existing?.type ?? TYPE_CODE[input.type ?? "login"];
    if (existing && !TYPE_NAME[type]) {
      throw new Error(`this app cannot change item type ${type}`);
    }
    // A form sends the revision it was opened on. If the vault has written the
    // item since, this save was composed against fields the owner can no
    // longer see — every one of them, not only the URLs — so it is refused
    // rather than allowed to overwrite whatever arrived in between.
    if (staleEdit(existing, input.revision)) {
      throw new Error("this item changed somewhere else while you had it open; reopen it and make the change again");
    }
    // Every URL the form showed is checked, because every one of them is a URL
    // the owner just looked at; a login with none can never be filled.
    if (type === 1 && input.urls !== undefined) {
      // A blank is an emptied row holding its position, not a URL to check.
      const typed = checkedUrls(input.urls.filter((u) => u.trim() !== ""));
      let at = 0;
      input = { ...input, urls: input.urls.map((u) => (u.trim() === "" ? "" : typed[at++])) };
    }
    // A key that cannot make a code is refused HERE, while the owner is still
    // looking at the box they pasted into — the six-digit code is the thing
    // people paste by mistake. Blank still clears it.
    if (typeof input.totp === "string" && input.totp.trim() !== "") {
      try {
        totpParams(input.totp);
      } catch (err) {
        throw new Error(
          `that is not an authenticator key: ${err instanceof Error ? err.message : String(err)}. ` +
            "Paste the setup key the site showed under its QR code, or the whole otpauth:// link.",
        );
      }
    }
    // Omitted means "leave it as it is"; supplied and blank means the owner
    // cleared the one field the list has to show, which is not a save.
    if (input.name !== undefined ? !input.name.trim() : !existing) {
      throw new Error("an item needs a name");
    }

    // The revision travels into the write: the staleEdit check above ran
    // against a snapshot taken before an await, and the store re-checks it
    // against the live row atomically (see VaultStore.upsert).
    const saved = this.store.upsert(encryptCipher(input, existing, key), input.itemId ? input.revision : undefined);
    this.audit(String(saved.id ?? ""), "(item)", input.itemId ? "UPDATED" : "CREATED");
    return { id: String(saved.id ?? ""), title: String(input.name ?? "") };
  }

  /** Throw an item away. Final: there is no server-side trash any more, which
   * the confirm dialog in front of this is expected to say. */
  async remove(itemId: string): Promise<void> {
    this.open(); // a locked vault refuses deletes too
    this.store.remove(itemId);
    this.audit(itemId, "(item)", "DELETED");
  }

  private audit(itemId: string, field: string, outcome: string): void {
    if (!this.auditPath) return;
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(
        this.auditPath,
        `${new Date().toISOString()}  item=${itemId}  field=${field}  page=OWNER  -> ${outcome}\n`,
      );
    } catch {
      /* an audit that cannot be written must not fail the owner's action */
    }
  }
}
