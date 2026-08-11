/**
 * Apple Passwords (iCloud Keychain) credential source, backed by the bundled
 * `apw` CLI (a deno-compiled binary vendored by scripts/build-browser-runtime.mjs;
 * provenance and pins in vendor/apw/UPSTREAM.md + runtime.lock.json).
 *
 * How apw works: `apw start` runs a foreground daemon that launches a
 * Chromium-family browser headless with Apple's own iCloud Passwords
 * extension, which speaks Apple's native-messaging protocol to the macOS
 * Passwords helper. Pairing is an SRP handshake confirmed by a PIN that macOS
 * shows in a native dialog; the pairing lives exactly as long as the daemon
 * process. Every query is a short-lived `apw` CLI invocation against the
 * daemon's Unix socket ($HOME/.apw/apw.sock).
 *
 * Trust model note (DESIGN.md §11a): once paired, apw answers any local
 * process — there is no per-item consent. Domo contains that by (a) keeping
 * the daemon alive only while the app runs and the setting is on, and (b)
 * enforcing origin/item scoping in BrowserSessions, same as for 1Password.
 * Apple's helper additionally binds every password release to the queried
 * URL's domain, which mirrors seed-op-broker's item-origin check.
 *
 * Secrets appear only in getField's return value, which the caller must hand
 * straight to the browser fill and drop — never to the agent, never to a log.
 */
import { ChildProcess, execFile, spawn } from "node:child_process";
import { JSONValue } from "@domo/protocol";
import {
  CredentialError,
  CredentialItemDescription,
  CredentialItemSummary,
  CredentialSource,
} from "./credentialBroker.js";

/** apw's own status codes (src/const.ts upstream). */
const APW_STATUS = {
  SUCCESS: 0,
  NO_RESULTS: 3,
  INVALID_SESSION: 9,
} as const;

export interface ApwConfig {
  /** Argv prefix for the apw binary, e.g. ["/…/browser-runtime/apw/arm64/apw"]. */
  command: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Fired when a query finds the daemon unpaired (the helper session dropped
   * or pairing never completed) — the app re-opens the PIN flow on this. */
  onNotPaired?: () => void;
}

interface ApwEntry {
  username?: string;
  domain?: string;
  title?: string;
  sites?: string[];
  highLevelDomain?: string;
  password?: string;
  code?: string;
  source?: string;
}

/** Map an apw failure (stderr JSON {error, status}) to a typed CredentialError. */
function apwError(status: number, message: string): CredentialError {
  if (status === APW_STATUS.INVALID_SESSION) {
    return new CredentialError(
      "ApwNotPaired",
      "Apple Passwords is not running or not paired — pair it in Domo Settings",
    );
  }
  if (status === APW_STATUS.NO_RESULTS) {
    return new CredentialError("ApwNoResults", message || "no matching Apple Passwords entry");
  }
  return new CredentialError("ApwFailed", message || `apw failed (status ${status})`);
}

/** Run one apw CLI invocation, returning parsed {results} or throwing typed. */
function runApw(cfg: ApwConfig, args: string[]): Promise<ApwEntry[]> {
  return new Promise((resolve, reject) => {
    execFile(
      cfg.command[0],
      [...cfg.command.slice(1), ...args],
      {
        env: { ...process.env, ...cfg.env },
        timeout: cfg.timeoutMs ?? 45_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          // apw prints one JSON line {error, status, results} on stderr for
          // every failure and exits with the status code.
          try {
            const parsed = JSON.parse(stderr.trim().split("\n").pop() ?? "") as {
              error?: string;
              status?: number;
            };
            if (typeof parsed.status === "number") {
              reject(apwError(parsed.status, parsed.error ?? ""));
              return;
            }
          } catch {
            /* fall through */
          }
          reject(new CredentialError("ApwFailed", stderr.trim() || error.message));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
            results?: ApwEntry[];
          };
          resolve(Array.isArray(parsed.results) ? parsed.results : []);
        } catch {
          reject(new CredentialError("ApwFailed", "apw returned unparseable output"));
        }
      },
    );
  });
}

/** Fields every Apple Passwords login exposes. Labels only — never values. */
const APW_FIELDS = ["username", "password", "otp"];

/**
 * Apple's helper matches on bare hostnames: a query carrying a scheme or path
 * returns NOTHING (observed live — `tumult.fogbugz.com` lists entries,
 * `https://tumult.fogbugz.com/login` lists none). The real extension queries
 * with hostnames too; strip every URL down to its host before it reaches apw.
 * This does not weaken the origin bound — BrowserSessions verifies the frame
 * origin before any query, and Apple's matching binds the release to this
 * same host.
 */
function apwHost(url: string): string {
  try {
    const host = new URL(url.includes("://") ? url : `https://${url}`).hostname;
    return host || url;
  } catch {
    return url;
  }
}

/**
 * CredentialSource over apw. Apple Passwords has no stable item ids, so the
 * item id IS the account's username: `pw get <url> <username>` is how apw
 * itself addresses an entry, and the device-observed frame URL rides along on
 * every release so Apple's own domain matching stays in the loop.
 */
export class ApwCredentialBroker implements CredentialSource {
  /** username → display title from the last listing (display-only cache; the
   * approval card falls back to the raw username when an id was never listed). */
  private readonly titles = new Map<string, string>();

  constructor(private readonly cfg: ApwConfig) {}

  /** All queries funnel through here so an unpaired daemon is reported to the
   * app (which re-opens the PIN flow) as well as to the caller. */
  private async run(args: string[]): Promise<ApwEntry[]> {
    try {
      return await runApw(this.cfg, args);
    } catch (error) {
      if (error instanceof CredentialError && error.type === "ApwNotPaired") {
        this.cfg.onNotPaired?.();
      }
      throw error;
    }
  }

  async whatsHere(url: string): Promise<CredentialItemSummary[]> {
    // apw only returns entries matching the queried URL (Apple's helper does
    // the domain matching), so everything listed matches this page.
    const entries = await this.run(["pw", "list", apwHost(url), "--json"]);
    return entries
      .filter((e) => typeof e.username === "string" && e.username !== "")
      .map((e) => {
        const domain = e.domain ?? e.highLevelDomain ?? "";
        const title = e.title ?? (domain ? `${e.username} (${domain})` : e.username!);
        this.titles.set(e.username!, title);
        return {
          id: e.username!,
          title,
          category: "login",
          username: e.username!,
          urls: Array.isArray(e.sites) && e.sites.length > 0 ? e.sites.map(String) : [domain].filter(Boolean),
          matchesThisPage: true,
        };
      });
  }

  async describeItem(itemId: string): Promise<CredentialItemDescription> {
    // apw has no by-id lookup without a URL; the id is the username and the
    // fields of a login are fixed. Title comes from the listing cache.
    return {
      id: itemId,
      title: this.titles.get(itemId) ?? itemId,
      category: "login",
      fields: [...APW_FIELDS],
    };
  }

  async getField(itemId: string, field: string, pageUrl: string): Promise<string> {
    const f = field.trim().toLowerCase();
    if (f === "otp" || f === "totp" || f === "one-time-code" || f === "code") {
      const entries = await this.run(["otp", "get", apwHost(pageUrl), "--json"]);
      const entry =
        entries.find((e) => e.username === itemId) ?? (entries.length === 1 ? entries[0] : undefined);
      if (!entry || typeof entry.code !== "string" || entry.code === "") {
        throw new CredentialError("ApwNoResults", `no one-time code for ${itemId} on this site`);
      }
      return entry.code;
    }
    if (f !== "password" && f !== "username") {
      throw new CredentialError(
        "ApwNoSuchField",
        `Apple Passwords items have fields ${APW_FIELDS.join("/")}, not "${field}"`,
      );
    }
    // The device-observed frame URL scopes the query: apw returns only entries
    // whose saved site matches it, so an item that belongs to another site
    // yields no results here — the same refusal seed-op-broker makes explicit.
    const entries = await this.run(["pw", "get", apwHost(pageUrl), itemId, "--json"]);
    const entry = entries.find((e) => e.username === itemId);
    if (!entry) {
      throw new CredentialError(
        "ApwDenied",
        `Apple Passwords has no entry for ${itemId} on this site`,
      );
    }
    if (f === "username") return entry.username ?? itemId;
    if (typeof entry.password !== "string" || entry.password === "") {
      throw new CredentialError("ApwDenied", "Apple Passwords did not release a password");
    }
    return entry.password;
  }
}

// ---------------------------------------------------------------------------
// Daemon lifecycle + pairing
// ---------------------------------------------------------------------------

export type ApwPairingState = "stopped" | "starting" | "awaiting-pin" | "paired" | "error";

export interface ApwStatus {
  state: ApwPairingState;
  /** Human-readable detail for the settings UI. Never contains a PIN. */
  detail: string;
}

export interface ApwDaemonConfig extends ApwConfig {
  /** apw `-b` browser choice; "auto" picks the first installed one. */
  browser?: string;
  /** How long to wait for the headless browser + extension (default 45s). */
  startTimeoutMs?: number;
  /** Pairing verification probe: how many times / how often to ask the daemon
   * whether the SRP session actually established after a PIN submission. */
  pairProbeAttempts?: number;
  pairProbeIntervalMs?: number;
  audit?: (event: string, fields: { [k: string]: JSONValue }) => void;
  onChange?: (status: ApwStatus) => void;
}

/**
 * Owns the `apw start` child process and the pairing state machine:
 *
 *   stopped → starting → awaiting-pin → paired
 *                ↘ error (no browser / no extension / daemon died)
 *
 * The pairing lives exactly as long as the child, so stop() (app quit or the
 * setting turned off) is also unpairing. PINs pass through submitPin() and are
 * never stored, audited, or logged.
 */
export class ApwDaemon {
  private child: ChildProcess | null = null;
  private current: ApwStatus = { state: "stopped", detail: "" };

  constructor(private readonly cfg: ApwDaemonConfig) {}

  status(): ApwStatus {
    return { ...this.current };
  }

  private setState(state: ApwPairingState, detail = ""): void {
    this.current = { state, detail };
    this.cfg.audit?.("apw_state", { state, detail });
    this.cfg.onChange?.(this.status());
  }

  /** Spawn the daemon and wait until its headless browser + extension are up.
   * Resolves with the daemon running (still unpaired); rejects (state=error)
   * when apw can't start — no supported browser, extension missing, etc. */
  async start(): Promise<void> {
    if (this.child) return;
    this.setState("starting", "Starting Apple Passwords helper…");

    const argv = [...this.cfg.command.slice(1), "start", "-b", this.cfg.browser ?? "auto"];
    const child = spawn(this.cfg.command[0], argv, {
      env: { ...process.env, ...this.cfg.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const failureDetail = (): string => {
      // apw's CLI prints one JSON line {error, status} on stderr when it exits.
      try {
        const parsed = JSON.parse(stderr.trim().split("\n").pop() ?? "") as { error?: string };
        if (parsed.error) return parsed.error;
      } catch {
        /* fall through */
      }
      return stderr.trim() || "apw daemon exited unexpectedly";
    };

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        fail("Apple Passwords helper timed out starting its browser");
        child.kill("SIGTERM");
      }, this.cfg.startTimeoutMs ?? 45_000);

      let settled = false;
      const fail = (detail: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        this.child = null;
        this.setState("error", detail);
        reject(new CredentialError("ApwStartFailed", detail));
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve();
      };

      // Ready = the Unix socket is listening AND the extension's bridge has
      // connected back to the daemon; apw logs one line for each.
      const onStdout = () => {
        if (stdout.includes("Unix socket at") && stdout.includes("extension connected")) {
          child.stdout?.removeListener("data", onStdout);
          succeed();
        }
      };
      child.stdout?.on("data", onStdout);
      child.on("error", (e) => fail(`could not run apw: ${e.message}`));
      child.on("exit", () => {
        if (!settled) {
          fail(failureDetail());
          return;
        }
        // The daemon died after a successful start: pairing is gone with it.
        this.child = null;
        if (this.current.state !== "stopped") {
          this.setState("error", "Apple Passwords helper stopped — re-enable to pair again");
        }
      });
    });
  }

  /** Ask the macOS Passwords helper to show its pairing PIN dialog. */
  async requestPin(): Promise<void> {
    await this.auth(["auth", "request"]);
    this.setState("awaiting-pin", "Enter the PIN shown by macOS");
  }

  /** Complete pairing with the PIN the user read off the macOS dialog.
   * Returns false (state stays awaiting-pin) on a rejected PIN.
   *
   * `auth response` exiting 0 only means the PIN was DELIVERED — apw's bridge
   * hands it to the extension's PINSet() and acks immediately, before the SRP
   * verification with the helper settles. So a claimed success is verified
   * here with a real query probe: only a daemon that answers something other
   * than INVALID_SESSION is actually paired. Without this, a mistyped PIN or
   * an expired dialog shows "paired" and every later fill fails. */
  async submitPin(pin: string): Promise<boolean> {
    const trimmed = pin.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      this.setState("awaiting-pin", "The PIN is the 6-digit code in the macOS dialog");
      return false;
    }
    try {
      await this.auth(["auth", "response", "--pin", trimmed]);
    } catch {
      // Never include the attempted PIN in state, audit, or logs.
      this.setState("awaiting-pin", "PIN not accepted — request a new PIN and try again");
      return false;
    }
    if (!(await this.probePaired())) {
      this.setState("awaiting-pin", "PIN not accepted — request a new PIN and try again");
      return false;
    }
    this.setState("paired", "Apple Passwords is paired for this app session");
    return true;
  }

  /** True once the daemon answers a query with anything but INVALID_SESSION.
   * The SRP verification settles asynchronously after PINSet, so poll briefly. */
  private async probePaired(): Promise<boolean> {
    const attempts = this.cfg.pairProbeAttempts ?? 10;
    const interval = this.cfg.pairProbeIntervalMs ?? 500;
    for (let i = 0; i < attempts; i++) {
      try {
        // A GHOST_SEARCH on a domain nobody has entries for: paired daemons
        // answer "no results" (success), unpaired ones INVALID_SESSION.
        await runApw(this.cfg, ["pw", "list", "https://domo-pairing-probe.invalid/", "--json"]);
        return true;
      } catch (error) {
        const unpaired = error instanceof CredentialError && error.type === "ApwNotPaired";
        if (!unpaired) return true; // it answered — the session exists
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, interval));
    }
    return false;
  }

  /** The helper session dropped out from under a paired daemon (service-worker
   * restart, helper exit). Re-enter the PIN flow so the next fill can succeed. */
  async repair(): Promise<void> {
    if (this.current.state !== "paired") return;
    await this.requestPin();
  }

  /** Kill the daemon (and with it, the pairing). Safe to call twice. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.setState("stopped", "");
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const hardKill = setTimeout(() => {
        child.kill("SIGKILL");
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(hardKill);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private auth(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(
        this.cfg.command[0],
        [...this.cfg.command.slice(1), ...args],
        {
          env: { ...process.env, ...this.cfg.env },
          timeout: this.cfg.timeoutMs ?? 30_000,
          maxBuffer: 1024 * 1024,
        },
        (error, _stdout, stderr) => {
          if (error) {
            try {
              const parsed = JSON.parse(stderr.trim().split("\n").pop() ?? "") as {
                error?: string;
                status?: number;
              };
              reject(apwError(parsed.status ?? 1, parsed.error ?? ""));
              return;
            } catch {
              reject(new CredentialError("ApwFailed", stderr.trim() || error.message));
              return;
            }
          }
          resolve();
        },
      );
    });
  }
}
