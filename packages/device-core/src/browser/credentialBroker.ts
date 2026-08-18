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

  private async run(args: string[], timeoutMs?: number, stdin?: string): Promise<string> {
    await this.cfg.beforeRun?.();
    return new Promise((resolve, reject) => {
      const child = execFile(
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
      // A password goes to the broker on stdin, never in argv: a command line
      // is readable by every process on this machine.
      if (stdin !== undefined) child.stdin?.end(stdin);
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

  /**
   * One field, shown to the OWNER in this app rather than filled into a page.
   * There is no page to bind it to, so no origin check runs and the broker
   * records the release as SEM-URL — call this only for something the owner
   * asked to see with their own eyes.
   */
  revealField(itemId: string, field: string): Promise<string> {
    return this.run(["get-field", "--item-id", itemId, "--field", field]);
  }

  /**
   * Create a login, or change one that is already there. Omit `password` on an
   * edit to leave it as it was. The broker refuses a login with no usable site,
   * because a login the fill path can never match is not worth storing.
   */
  async saveItem(input: {
    itemId?: string;
    title?: string;
    username?: string;
    urls?: string[];
    password?: string;
  }): Promise<{ id: string; title: string }> {
    const args = ["save-item"];
    if (input.itemId) args.push("--item-id", input.itemId);
    if (input.title !== undefined) args.push("--title", input.title);
    if (input.username !== undefined) args.push("--username", input.username);
    for (const url of input.urls ?? []) args.push("--url", url);
    if (input.password) args.push("--password-stdin");
    const out = await this.run(args, undefined, input.password ?? "");
    const saved = JSON.parse(out) as { [k: string]: JSONValue };
    return { id: String(saved.id ?? ""), title: String(saved.title ?? "") };
  }
}
