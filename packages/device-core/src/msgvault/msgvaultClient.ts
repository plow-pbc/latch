/**
 * Thin wrapper over the msgvault CLI. Every call is a short-lived process;
 * msgvault itself discovers-or-spawns its long-lived daemon (which owns the
 * SQLite archive), so this client never manages daemon state beyond the
 * shutdown-time `daemon stop` for a home we own.
 *
 * This runs OUTSIDE the seatbelt Executor on purpose: a sandbox-exec child
 * cannot use the app's Full Disk Access grant (TCC keys on the responsible
 * app), and msgvault detaches a daemon no profile could contain. The
 * enforceable bound is the approved msgvault capability plus the fixed argv
 * shapes below — agent strings only ever appear after a `--` terminator, so
 * they can never become flags.
 */
import { execFile } from "node:child_process";
import { JSONValue } from "@domo/protocol";

export class MsgvaultError extends Error {
  constructor(
    public readonly kind: "timeout" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "MsgvaultError";
  }
}

export interface MsgvaultSearchParams {
  query: string;
  limit?: number;
  offset?: number;
  account?: string;
}

export interface MsgvaultClientConfig {
  /** Argv prefix, e.g. the bundled binary's path or a test fake. */
  command: string[];
  /**
   * Where the archive lives — always a directory Domo owns (inside
   * DOMO_HOME), so every instance (branch homes, test homes) is hermetic and
   * a user's own ~/.msgvault is never touched.
   */
  msgvaultHome: string;
  timeoutMs?: number;
  importTimeoutMs?: number;
  maxBuffer?: number;
}

const QUERY_TIMEOUT_MS = 30_000;
const IMPORT_TIMEOUT_MS = 300_000;
const HOUSEKEEPING_TIMEOUT_MS = 10_000;

export class MsgvaultClient {
  constructor(private readonly cfg: MsgvaultClientConfig) {}

  private run(args: string[], timeoutMs?: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.cfg.command[0],
        [...this.cfg.command.slice(1), ...args],
        {
          env: {
            // Full inheritance on purpose: the CLI re-execs itself as the
            // daemon and needs a real HOME and PATH to do it.
            ...process.env,
            MSGVAULT_HOME: this.cfg.msgvaultHome,
          },
          timeout: timeoutMs ?? this.cfg.timeoutMs ?? QUERY_TIMEOUT_MS,
          maxBuffer: this.cfg.maxBuffer ?? 8 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            const timedOut = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
            reject(
              new MsgvaultError(
                timedOut ? "timeout" : "failed",
                timedOut ? "msgvault timed out" : stderr.trim() || error.message,
              ),
            );
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  private parse(stdout: string): JSONValue {
    try {
      return JSON.parse(stdout) as JSONValue;
    } catch {
      throw new MsgvaultError("failed", "msgvault returned unparseable output");
    }
  }

  async search(params: MsgvaultSearchParams): Promise<JSONValue> {
    const limit = Math.min(Math.max(Math.trunc(params.limit ?? 20), 1), 100);
    const offset = Math.max(Math.trunc(params.offset ?? 0), 0);
    const args = ["search", "--json", "--limit", String(limit)];
    if (offset > 0) args.push("--offset", String(offset));
    if (params.account) args.push("--account", params.account);
    return this.parse(await this.run([...args, "--", params.query]));
  }

  async showMessage(id: string): Promise<JSONValue> {
    return this.parse(await this.run(["show-message", "--json", "--", id]));
  }

  async stats(): Promise<JSONValue> {
    // --json is assumed but not guaranteed across versions; a plain-text
    // stats page is still useful, so fall back rather than fail.
    try {
      return this.parse(await this.run(["stats", "--json"]));
    } catch (e) {
      if (e instanceof MsgvaultError && e.kind === "timeout") throw e;
      const text = await this.run(["stats"]);
      return { text };
    }
  }

  async importIMessage(limit: number): Promise<{ output: string }> {
    const output = await this.run(
      ["import-imessage", "--limit", String(Math.trunc(limit))],
      this.cfg.importTimeoutMs ?? IMPORT_TIMEOUT_MS,
    );
    return { output };
  }

  async version(): Promise<string | null> {
    try {
      // `msgvault version` prints "msgvault vX.Y.Z" then build detail lines.
      const out = await this.run(["version"], HOUSEKEEPING_TIMEOUT_MS);
      return out.trim().split("\n")[0]?.trim() || null;
    } catch {
      return null;
    }
  }

  /** Stop the daemon we spawned — it lives in our home, so it is ours to stop. */
  async stopDaemon(): Promise<void> {
    await this.run(["daemon", "stop"], HOUSEKEEPING_TIMEOUT_MS);
  }
}
