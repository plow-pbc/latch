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
}

export interface CredentialItemSummary {
  id: string;
  title: string;
  category: string;
  username: string;
  urls: string[];
  matchesThisPage: boolean;
}

export class CredentialBroker {
  constructor(private readonly cfg: CredentialBrokerConfig) {}

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.cfg.command[0],
        [...this.cfg.command.slice(1), ...args],
        {
          env: {
            ...process.env,
            ...this.cfg.env,
            ...(this.cfg.auditPath ? { SEED_VAULT_AUDIT: this.cfg.auditPath } : {}),
            ...(this.cfg.person ? { SEED_VAULT_PERSON: this.cfg.person } : {}),
            ...(this.cfg.fleetToken ? { SEED_VAULT_TOKEN: this.cfg.fleetToken } : {}),
          },
          timeout: this.cfg.timeoutMs ?? 45_000,
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

  /** Everything in the vault, metadata only. Never a secret value. */
  async whatsHere(url: string): Promise<CredentialItemSummary[]> {
    const out = await this.run(["whats-here", "--url", url]);
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

  /** One item's field labels — never values. */
  async describeItem(itemId: string): Promise<{ id: string; title: string; category: string; fields: string[] }> {
    const out = await this.run(["describe-item", "--item-id", itemId]);
    const item = JSON.parse(out) as { [k: string]: JSONValue };
    return {
      id: String(item.id ?? ""),
      title: String(item.title ?? ""),
      category: String(item.category ?? ""),
      fields: Array.isArray(item.fields) ? item.fields.map(String) : [],
    };
  }

  /**
   * One field of one item, bound to the page URL the DEVICE observed (the
   * broker refuses a login off its own site; cards deliberately pass).
   * The returned secret must go straight into a fill and be dropped.
   */
  getField(itemId: string, field: string, pageUrl: string): Promise<string> {
    return this.run(["get-field", "--item-id", itemId, "--field", field, "--url", pageUrl]);
  }
}
