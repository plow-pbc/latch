/**
 * Thin wrapper over the vendored seed-op-broker CLI (1Password resolver).
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
  /** Argv prefix, e.g. [python, "-m", "seed_op_broker"] or a test fake. */
  command: string[];
  env?: Record<string, string>;
  /** Where seed-op-broker writes its own audit lines. */
  opAuditPath?: string;
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

export interface CredentialItemDescription {
  id: string;
  title: string;
  category: string;
  fields: string[];
}

/**
 * What BrowserSessions and the approval UI need from a credential backend.
 * Implemented by CredentialBroker (1Password via seed-op-broker) and
 * ApwCredentialBroker (Apple Passwords via the bundled apw CLI).
 */
export interface CredentialSource {
  /** Metadata only. Never a secret value. */
  whatsHere(url: string): Promise<CredentialItemSummary[]>;
  /** One item's field labels — never values. */
  describeItem(itemId: string): Promise<CredentialItemDescription>;
  /** One field of one item, bound to the device-observed page URL. The
   * returned secret must go straight into a fill and be dropped. */
  getField(itemId: string, field: string, pageUrl: string): Promise<string>;
}

/**
 * The active credential backend, swappable at runtime: the desktop app points
 * it at Apple Passwords when that setting is enabled and back at the default
 * (1Password) when it is not. BrowserSessions and the approval UI hold this
 * one object for the app's lifetime, so a toggle needs no rebuild of the
 * session layer — and every switch is audited (never silently).
 */
export class CredentialSourceSwitch implements CredentialSource {
  private backend: CredentialSource | null;
  private backendName: string;

  constructor(
    private readonly defaultBackend: CredentialSource | null,
    private readonly defaultName: string,
    private readonly onSwitch?: (source: string) => void,
  ) {
    this.backend = defaultBackend;
    this.backendName = defaultName;
  }

  /** The name of the active backend ("1password", "apple-passwords"). */
  get active(): string {
    return this.backendName;
  }

  set(backend: CredentialSource, name: string): void {
    if (this.backend === backend) return;
    this.backend = backend;
    this.backendName = name;
    this.onSwitch?.(name);
  }

  /** Restore the backend the switch was constructed with. */
  reset(): void {
    if (this.backend === this.defaultBackend) return;
    this.backend = this.defaultBackend;
    this.backendName = this.defaultName;
    this.onSwitch?.(this.defaultName);
  }

  private required(): CredentialSource {
    if (!this.backend) {
      throw new CredentialError("NoCredentialSource", "no credential source is available");
    }
    return this.backend;
  }

  whatsHere(url: string): Promise<CredentialItemSummary[]> {
    return this.required().whatsHere(url);
  }

  describeItem(itemId: string): Promise<CredentialItemDescription> {
    return this.required().describeItem(itemId);
  }

  getField(itemId: string, field: string, pageUrl: string): Promise<string> {
    return this.required().getField(itemId, field, pageUrl);
  }
}

export class CredentialBroker implements CredentialSource {
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
            ...(this.cfg.opAuditPath ? { SEED_OP_AUDIT: this.cfg.opAuditPath } : {}),
          },
          timeout: this.cfg.timeoutMs ?? 45_000,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            // seed-op-broker emits one JSON line {type, message} on stderr for
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
