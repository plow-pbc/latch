/**
 * Thin wrapper over the seed-vault-broker CLI (our self-hosted vault resolver).
 * Every call is a short-lived process; secrets appear only in getField's
 * return value, which the caller must hand straight to the browser fill and
 * drop — never to the agent, never to the audit log.
 */
import { execFile } from "node:child_process";
import { JSONValue } from "@domo/protocol";

export class CredentialError extends Error {
  constructor(
    public readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

export interface CredentialBrokerConfig {
  /** Argv prefix, e.g. ["seed-vault-broker"] or a test fake. */
  command: string[];
  env?: Record<string, string>;
  /** Where the broker writes its own audit lines. */
  auditPath?: string;
  /** Whose vault this machine reads, and the token that fetches that agent's
   * access. Both come from the app's settings, not from a file next to the code. */
  person?: string;
  fleetToken?: string;
  timeoutMs?: number;
  /** Extra environment resolved AT CALL TIME. A plain object cannot carry the
   * vault account, because it does not exist yet when this is constructed. */
  envFor?: () => Record<string, string>;
  /** Awaited before every call. When the vault runs on this Mac, this is what
   * starts it — the broker is the only thing that needs it up, so it pays the
   * cold start rather than app launch. Idempotent by contract. */
  beforeRun?: () => Promise<void>;
}

/**
 * One field of a vault item, as `describe-item` reports it.
 *
 * A type alias rather than an interface so it stays assignable to `JSONValue`:
 * these travel out to the agent as-is through `vaultDescribe`.
 */
export type CredentialFieldInfo = {
  /** Exactly the token `get-field` accepts for this field. */
  label: string;
  /** True when the vault itself renders this field masked (a login password, a
   * card number or security code, a Hidden custom field). The classification is
   * the vault's, and thereby the human's who made the item. */
  hidden: boolean;
  /** A named custom field rather than a built-in slot. A custom field may share
   * a built-in's name, so this is what tells the two apart. */
  custom: boolean;
  /** An alternative name `get-field` accepts for a slot already listed (`cvv`
   * for a card's `code`, `email` for a login's `username`). The broker decides
   * what these are and what they mean; nothing above it keeps a second copy. */
  alias: boolean;
};

/** One released field: the value, and whether the vault conceals it. */
export interface CredentialRelease {
  value: string;
  hidden: boolean;
}

export interface CredentialItemSummary {
  id: string;
  title: string;
  category: string;
  username: string;
  urls: string[];
  matchesThisPage: boolean;
}

/**
 * One `describe-item` field entry, or nothing when it is not one.
 *
 * `hidden` is never inferred: a field the broker did not describe as masked is
 * dropped rather than reported visible, because a wrong `false` is exactly the
 * mistake that puts a secret back on the agent's screen.
 */
function fieldInfo(raw: JSONValue): CredentialFieldInfo[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const entry = raw as { [k: string]: JSONValue };
  if (typeof entry.label !== "string" || entry.label === "") return [];
  if (typeof entry.hidden !== "boolean") return [];
  return [
    {
      label: entry.label,
      hidden: entry.hidden,
      custom: entry.custom === true,
      alias: entry.alias === true,
    },
  ];
}

export class CredentialBroker {
  constructor(private readonly cfg: CredentialBrokerConfig) {}

  private async run(args: string[], timeoutMs?: number): Promise<string> {
    await this.cfg.beforeRun?.();
    return new Promise((resolve, reject) => {
      execFile(
        this.cfg.command[0],
        [...this.cfg.command.slice(1), ...args],
        {
          env: {
            ...process.env,
            ...this.cfg.env,
            ...(this.cfg.envFor?.() ?? {}),
            ...(this.cfg.auditPath ? { SEED_VAULT_AUDIT: this.cfg.auditPath } : {}),
            ...(this.cfg.person ? { SEED_VAULT_PERSON: this.cfg.person } : {}),
            ...(this.cfg.fleetToken ? { SEED_VAULT_TOKEN: this.cfg.fleetToken } : {}),
          },
          timeout: timeoutMs ?? this.cfg.timeoutMs ?? 45_000,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            // the broker emits one JSON line {type, message} on stderr for
            // every typed failure; surface it as a structured error.
            try {
              const parsed = JSON.parse(stderr.trim().split("\n").pop() ?? "") as {
                type?: string;
                message?: string;
              };
              if (parsed.type) {
                reject(new CredentialError(parsed.type, parsed.message ?? parsed.type));
                return;
              }
            } catch {
              /* fall through */
            }
            reject(new CredentialError("BrokerFailed", stderr.trim() || error.message));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  /**
   * Sign in once, off the critical path. The first call after a launch pays for
   * a key derivation and a sync, which together take longer than a browser
   * action is allowed to; every call after that reuses the session. Failures
   * are the caller's problem later, not a reason to hold up startup.
   */
  async warm(): Promise<void> {
    try {
      await this.run(["status"], 60_000);
    } catch {
      /* the next real call reports it properly */
    }
  }

  /**
   * Everything in the vault, metadata only. Never a secret value. The page is
   * optional: with one, each entry says whether it belongs to that page; without,
   * this is simply what the vault holds.
   */
  async whatsHere(url?: string): Promise<CredentialItemSummary[]> {
    const out = await this.run(["whats-here", ...(url ? ["--url", url] : [])]);
    const items = JSON.parse(out) as Array<{ [k: string]: JSONValue }>;
    return items.map((i) => ({
      id: String(i.id ?? ""),
      title: String(i.title ?? ""),
      category: String(i.category ?? ""),
      username: String(i.username ?? ""),
      urls: Array.isArray(i.urls) ? i.urls.map(String) : [],
      matchesThisPage: i.matches_this_page === true,
    }));
  }

  /** One item's fields — labels and whether the vault masks them, never values. */
  async describeItem(
    itemId: string,
  ): Promise<{ id: string; title: string; category: string; fields: CredentialFieldInfo[] }> {
    const out = await this.run(["describe-item", "--item-id", itemId]);
    const item = JSON.parse(out) as { [k: string]: JSONValue };
    return {
      id: String(item.id ?? ""),
      title: String(item.title ?? ""),
      category: String(item.category ?? ""),
      fields: Array.isArray(item.fields) ? item.fields.flatMap(fieldInfo) : [],
    };
  }

  /**
   * One field of one item, bound to the page URL the DEVICE observed (the
   * broker refuses a login off its own site; cards deliberately pass).
   *
   * The value arrives with `hidden` beside it, out of one reading of the item,
   * because the two have to be true of the same field at the same moment: ask
   * separately and an item edited in between releases a concealed value under
   * the answer given for the old one. The secret must go straight into a fill
   * and be dropped.
   */
  async getField(itemId: string, field: string, pageUrl: string): Promise<CredentialRelease> {
    const out = await this.run(["get-field", "--item-id", itemId, "--field", field, "--url", pageUrl]);
    const parsed = JSON.parse(out) as { [k: string]: JSONValue };
    if (typeof parsed.value !== "string" || typeof parsed.hidden !== "boolean") {
      // Never guess the flag: a shape this side cannot read is a refusal, not a
      // value released under an assumed classification.
      throw new CredentialError("BrokerFailed", "the vault did not say whether this field is concealed");
    }
    return { value: parsed.value, hidden: parsed.hidden };
  }

}
