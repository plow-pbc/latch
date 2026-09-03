/**
 * The credential broker's behavior, in-process: what the vendored Python
 * broker (seed_vault_broker) did over a CLI, done as functions against the
 * local vault store. Same commands, same denial rules, same audit lines —
 * the contract every fill test is written against — with the vault server,
 * the Bitwarden CLI and the subprocess all gone. The master key never leaves
 * this process.
 *
 * One deliberate divergence from the Python broker: the site check compares
 * hosts by label suffix (its root PSL-checked — see hostsRelated) instead of
 * by eTLD+1 equality. A login stored for `chase.com` still releases on
 * `secure.chase.com` and vice versa; what no longer matches is two SIBLING
 * subdomains with no stored apex, which is the stricter side to fail on.
 *
 * Secrets appear only in getField's return value; every other answer is
 * metadata. Every describe and every release attempt appends one line to the
 * credential audit log — never a value.
 */
import fs from "node:fs";
import path from "node:path";
import { getDomain } from "tldts";
import { CredentialError } from "./credentialBroker.js";
import {
  categoryOf,
  fieldDescriptors,
  fieldLabels,
  readField,
  FIELD_TOTP,
} from "./credentialClassify.js";
import { totpCode } from "./vaultTotp.js";
import { decryptRaw, splitKey, RawItem } from "./vaultItems.js";
import { VaultKeyStore } from "./vaultKeyStore.js";
import { openVaultKey } from "./vaultMigrate.js";
import { VaultStore } from "./vaultStore.js";

export interface BrokerCoreConfig {
  /** Where the vault lives — openVaultKey needs the directory to find a
   * legacy vault awaiting migration. */
  dir: string;
  store: VaultStore;
  keyStore: VaultKeyStore;
  /** One line per describe and per release attempt. Never a value. */
  auditPath?: string;
}

export class BrokerCore {
  constructor(private readonly cfg: BrokerCoreConfig) {}

  /**
   * Every item, decrypted to the classifier's shape — through the SAME open
   * path the Vault tab uses, so a fresh install answers with an empty listing
   * (minting its key) and a pending migration completes here too, whichever
   * side asks first. Only a genuinely locked vault throws.
   */
  private items(): RawItem[] {
    const split = splitKey(this.openKey());
    return this.cfg.store.readAll().map((c) => decryptRaw(c, split));
  }

  private openKey(): Buffer {
    try {
      return openVaultKey(this.cfg.dir, this.cfg.keyStore, this.cfg.store);
    } catch (err) {
      throw new CredentialError(
        "VaultLocked",
        `The vault could not be unlocked: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private item(itemId: string): RawItem {
    const found = this.items().find((i) => i.id === itemId);
    if (!found) throw new CredentialError("VaultNotFound", "No such item in the vault.");
    return found;
  }

  status(): { ok: boolean; signed_in: boolean } {
    return { ok: true, signed_in: this.cfg.keyStore.readKey() !== null };
  }

  /**
   * Every item in reach, metadata only. Nothing is filtered out by host: a
   * card has no site at all, and a login for another host is often the right
   * answer (a store checkout that hands off to PayPal wants the PayPal login).
   * `matchesThisPage` is advice, not a filter — the agent decides.
   */
  whatsHere(url?: string): Array<{
    id: string;
    title: string;
    category: string;
    username: string;
    urls: string[];
    matchesThisPage: boolean;
  }> {
    const page = url ? hostKey(url) : null;
    if (url && !page) {
      throw new CredentialError("InvalidArgument", `could not read a host from ${JSON.stringify(url)}`);
    }
    return this.items().map((item) => {
      const urls = itemUrls(item);
      return {
        id: item.id,
        title: item.name,
        category: categoryOf(item),
        username: item.login?.username ?? "",
        urls,
        matchesThisPage: page !== null && itemHostKeys(item).some((k) => hostsRelated(k, page)),
      };
    });
  }

  /** Field LABELS of one item — never their values. */
  describeItem(itemId: string): {
    id: string;
    title: string;
    category: string;
    fields: ReturnType<typeof fieldDescriptors>;
  } {
    const item = this.item(itemId);
    this.audit(itemId, "(labels)", "-", "DESCRIBED");
    return {
      id: item.id,
      title: item.name,
      category: categoryOf(item),
      fields: fieldDescriptors(item),
    };
  }

  /**
   * One field of one item, bound to the page. The site check is about LOGINS:
   * a login belongs to its site. Everything else in a vault — cards, notes,
   * addresses — is not tied to a site by nature and is released and logged
   * rather than blocked. Within logins, an item carrying no site at all is
   * still refused: treating "no sites" as "every site" hands the password to
   * whatever page happens to be open. Without a URL there is NO origin check
   * and the audit records SEM-URL.
   */
  getField(itemId: string, field: string, pageUrl?: string): { value: string; hidden: boolean } {
    const page = pageUrl ? hostKey(pageUrl) : null;
    if (pageUrl && !page) {
      throw new CredentialError("InvalidArgument", `could not read a host from ${JSON.stringify(pageUrl)}`);
    }
    let item: RawItem;
    try {
      item = this.item(itemId);
    } catch (err) {
      const type = err instanceof CredentialError ? err.type : "VaultError";
      this.audit(itemId, field, page ?? "SEM-URL", `ERROR ${type}`);
      throw err;
    }

    if (page && categoryOf(item) === "LOGIN") {
      const keys = itemHostKeys(item);
      if (keys.length === 0) {
        this.audit(itemId, field, page, "DENIED no site on item");
        throw new CredentialError(
          "VaultDenied",
          `item is not tied to any site, so it cannot be released on ${page}`,
        );
      }
      if (!keys.some((k) => hostsRelated(k, page))) {
        this.audit(itemId, field, page, "DENIED origin mismatch");
        throw new CredentialError("VaultDenied", `item belongs to ${keys.join(", ")}, not to ${page}`);
      }
    }

    // ONE resolution answers everything: whether this item offers the field at
    // all, and whether the vault conceals it. Value and flag come out of one
    // reading, so a caller can never act on a stale answer to either question.
    const descriptor = fieldDescriptors(item).find((d) => d.label === field);
    if (!descriptor) {
      this.audit(itemId, field, page ?? "SEM-URL", "ERROR InvalidArgument");
      throw new CredentialError(
        "InvalidArgument",
        `this item does not offer ${JSON.stringify(field)}; it offers: ${fieldLabels(item).join(", ") || "nothing"}`,
      );
    }

    let value: string | null;
    if (field === FIELD_TOTP) {
      // The stored value is the authenticator KEY; what a form wants is the
      // code it is showing right now.
      const seed = item.login?.totp;
      try {
        value = seed ? totpCode(seed).code : null;
      } catch {
        value = null;
      }
      if (value === null) {
        this.audit(itemId, field, page ?? "SEM-URL", "ERROR VaultNotFound");
        throw new CredentialError("VaultNotFound", "this item's authenticator key cannot make a code");
      }
    } else {
      value = readField(item, field);
      if (value === null) {
        this.audit(itemId, field, page ?? "SEM-URL", "ERROR VaultNotFound");
        throw new CredentialError("VaultNotFound", `item has no ${field}`);
      }
    }

    this.audit(itemId, field, page ?? "SEM-URL", "RELEASED");
    return { value, hidden: descriptor.hidden };
  }

  /** Same line the Python broker and the test fake write. Never the value. */
  private audit(itemId: string, field: string, page: string, outcome: string): void {
    if (!this.cfg.auditPath) return;
    try {
      fs.mkdirSync(path.dirname(this.cfg.auditPath), { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
      fs.appendFileSync(
        this.cfg.auditPath,
        `${stamp}  item=${itemId}  field=${field}  page=${page}  -> ${outcome}\n`,
      );
    } catch {
      /* an audit that cannot be written must not decide a release */
    }
  }
}

const HTTP_SCHEMES = new Set(["http:", "https:"]);

/** Stable key for "the page I am on": the hostname. localhost and bare IPs
 * count — falling back to the host keeps local pages usable without teaching
 * the broker anything about any particular site. */
export function hostKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!HTTP_SCHEMES.has(parsed.protocol) || !parsed.hostname) return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Two hosts belong to the same site when they are equal or share a registrable
 * domain — the rule every password manager fills by, so an imported login that
 * names `secure.opentable.com` still fills the form on `www.opentable.com`.
 * Plain label-suffix logic cannot tell a public suffix from somebody's domain
 * (`attacker.github.io` shares a suffix with `victim.github.io`); only the
 * Public Suffix List knows, so the shared root must be a registrable domain by
 * the pinned PSL (`tldts`, private section included — `github.io` is as public
 * as `co.uk`). Exact matches stay PSL-free, which keeps localhost and bare-IP
 * fills working. This is deliberately the ONE PSL use in the repo:
 * session-grant origin patterns are owner-approved literals and stay dumb
 * (DESIGN.md §11a); this comparison is the code inferring relatedness on its
 * own, which is exactly what the old broker used its PSL for.
 */
export function hostsRelated(a: string, b: string): boolean {
  if (a === b) return true;
  const root = getDomain(a, { allowPrivateDomains: true });
  return root !== null && root === getDomain(b, { allowPrivateDomains: true });
}

function itemUrls(item: RawItem): string[] {
  return (item.login?.uris ?? []).map((u) => u.uri).filter(Boolean);
}

function itemHostKeys(item: RawItem): string[] {
  return itemUrls(item)
    .map(hostKey)
    .filter((k): k is string => k !== null);
}
