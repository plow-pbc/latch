/**
 * Supervises the long-lived Camoufox server process (vendor/browser-server).
 * Protocol: JSON lines over stdio — requests {"id", "action", ...} on the
 * child's stdin, responses {"id", "result"|"error"} on its stdout, preceded by
 * a single {"status":"ready"} line once the browser is actually up.
 *
 * Lifecycle: lazy start on first action; crash rejects pending requests and
 * the next action restarts (with a circuit breaker); shutdown kills the whole
 * process group — Camoufox leaves Firefox grandchildren behind otherwise.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { JSONValue, jv } from "@domo/protocol";

/** One frame for the owner's viewer window (browserHost.viewFrame). */
export interface ViewerFrame {
  dataB64: string;
  mime: string;
  /** URL of the page the frame shows, straight from the server envelope. */
  url: string;
}

export class BrowserCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserCrashedError";
  }
}

export interface BrowserHostConfig {
  /** Argv for the server (python + server.py, or a fake in tests). */
  command: string[];
  env?: Record<string, string>;
  screenshotsDir: string;
  profileDir?: string;
  /** Camoufox install dir (config.json + browsers/). When set, the server is
   * spawned with an app-scoped $HOME whose Library/Caches/camoufox symlinks
   * to it — camoufox finds a ready install, the user's shared cache is never
   * touched, and no network fetch can happen at launch. */
  camoufoxInstallDir?: string | null;
  /** The app-scoped $HOME for the server (required with camoufoxInstallDir). */
  isolatedHome?: string;
  /** Default window mode when a session does not ask for one (ensureReady). */
  headed?: boolean;
  audit?: (event: string, fields: { [k: string]: JSONValue }) => void;
  /** Cold start is ~30 s (Camoufox unpack + launch); default 90 s. */
  startTimeoutMs?: number;
  actionTimeoutMs?: number;
}

interface Pending {
  resolve: (v: { [k: string]: JSONValue }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_IN_WINDOW = 3;

/** How many refused requests the host holds for the next agent action. */
const MAX_FAILED_REQUESTS = 5;

export class BrowserHost {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private restartTimes: number[] = [];
  private stderrTail: string[] = [];
  private failedRequests: JSONValue[] = [];
  private shuttingDown = false;
  /** Browser version reported by the ready line (empty until started). */
  browserVersion = "";

  /** Set by the session layer: fires when a ready browser dies unexpectedly,
   * so the session over it can be closed out rather than left open forever. */
  onCrash?: () => void;

  /** Window mode of the current (or next) browser — a session may switch it. */
  private headedNow: boolean;

  constructor(private readonly cfg: BrowserHostConfig) {
    this.headedNow = cfg.headed === true;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Whether the next (or current) browser shows a window. */
  get headed(): boolean {
    return this.headedNow;
  }

  /**
   * Requests the site refused, taken off every server response and held until
   * an agent action carries them out (most recent first, bounded).
   *
   * The browser reports what it saw to whoever asked, and most of the asking is
   * the device's own: the owner's viewer polls ~1/s, the popup sweep runs
   * `pages`, a credential fill runs `locate` first. Whichever of those was in
   * flight would otherwise be the one that consumed a 429 and dropped it, so
   * the browser reports and forgets and the holding happens here — the one
   * place every response passes through, whoever asked for it.
   */
  takeFailedRequests(): JSONValue[] {
    const taken = this.failedRequests;
    this.failedRequests = [];
    return taken;
  }

  /** Send one action to the server, lazily starting it. */
  async sendAction(action: { [k: string]: JSONValue }): Promise<{ [k: string]: JSONValue }> {
    if (this.shuttingDown) throw new BrowserCrashedError("browser host is shut down");
    await this.ensureStarted();
    const id = this.nextId++;
    const child = this.child!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserCrashedError("browser action timed out"));
      }, this.cfg.actionTimeoutMs ?? 60_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify({ id, ...action }) + "\n", (err) => {
        if (err) {
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            p.reject(new BrowserCrashedError(`browser write failed: ${err.message}`));
          }
        }
      });
    });
  }

  /**
   * One screenshot frame for the owner's viewer window. Strictly best-effort:
   * returns null when the browser isn't running (and never starts it — a
   * viewer poll must not be able to launch Camoufox), and null on any failure
   * (frame mid-navigation, action timeout, crash). Deliberately NOT routed
   * through BrowserSessions: the frame is for the device owner's own eyes, so
   * session scope does not apply, and a ~1/s poll must not flood the audit log.
   */
  async viewFrame(): Promise<ViewerFrame | null> {
    if (!this.child || this.shuttingDown) return null;
    try {
      const result = await this.sendAction({ action: "view" });
      const dataB64 = typeof result.data_b64 === "string" ? result.data_b64 : null;
      if (dataB64 === null) return null;
      return {
        dataB64,
        mime: typeof result.mime === "string" ? result.mime : "image/jpeg",
        url: typeof result.url === "string" ? result.url : "",
      };
    } catch {
      return null;
    }
  }

  /**
   * Start the browser if it isn't already running and resolve once it's ready.
   * Called from plow_browser_open (a deferrable tool) so the ~30s cold start is paid
   * there, absorbed by the deferred handle, rather than by a later
   * non-deferrable action that would blow the relay's per-exchange ceiling.
   *
   * `headed` is the session's choice; a session that says nothing gets the app
   * default back, so one agent's hidden window never becomes everybody's.
   * Camoufox fixes the window mode at launch, and this is the only caller, so
   * the mode is simply chosen for the next start — closing a session already
   * shut the previous browser down.
   */
  ensureReady(headed?: boolean): Promise<void> {
    this.headedNow = headed ?? this.cfg.headed === true;
    return this.ensureStarted();
  }

  private ensureStarted(): Promise<void> {
    if (this.child) return Promise.resolve();
    if (this.starting) return this.starting;

    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restartTimes.length >= MAX_RESTARTS_IN_WINDOW) {
      return Promise.reject(
        new BrowserCrashedError(
          `browser crashed ${this.restartTimes.length} times in the last minute; giving up`,
        ),
      );
    }
    this.restartTimes.push(now);

    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private start(): Promise<void> {
    fs.mkdirSync(this.cfg.screenshotsDir, { recursive: true });
    const extraEnv: Record<string, string> = { ...this.cfg.env };
    if (this.cfg.camoufoxInstallDir) {
      const home = this.cfg.isolatedHome;
      if (!home) throw new BrowserCrashedError("camoufoxInstallDir requires isolatedHome");
      const caches = path.join(home, "Library", "Caches");
      fs.mkdirSync(caches, { recursive: true });
      const link = path.join(caches, "camoufox");
      try {
        fs.unlinkSync(link);
      } catch {
        /* absent or a real dir — rmSync below covers the dir case */
      }
      fs.rmSync(link, { recursive: true, force: true });
      fs.symlinkSync(this.cfg.camoufoxInstallDir, link);
      extraEnv.HOME = home;
    }
    const argv = [
      ...this.cfg.command,
      "--screenshots-dir",
      this.cfg.screenshotsDir,
      ...(this.cfg.profileDir ? ["--profile-dir", this.cfg.profileDir] : []),
      ...(this.headedNow ? ["--headed"] : []),
    ];
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group, so shutdown can kill Firefox children
    });
    this.child = child;
    this.stderrTail = [];
    // A new browser saw none of the old one's traffic.
    this.failedRequests = [];

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      this.stderrTail.push(chunk);
      while (this.stderrTail.length > 50) this.stderrTail.shift();
    });

    const rl = readline.createInterface({ input: child.stdout! });

    return new Promise<void>((resolve, reject) => {
      let ready = false;
      const startTimer = setTimeout(() => {
        if (!ready) {
          this.killGroup("SIGKILL");
          this.child = null;
          reject(
            new BrowserCrashedError(
              `browser server did not become ready: ${this.stderrTail.join("").slice(-500)}`,
            ),
          );
        }
      }, this.cfg.startTimeoutMs ?? 90_000);
      startTimer.unref?.();

      rl.on("line", (line) => {
        let msg: JSONValue;
        try {
          msg = JSON.parse(line) as JSONValue;
        } catch {
          return; // tolerate garbage on the channel
        }
        const m = jv(msg);
        if (!ready) {
          if (m.get("status").str === "ready") {
            ready = true;
            clearTimeout(startTimer);
            this.browserVersion = m.get("browser_version").str ?? "";
            this.cfg.audit?.("browser_started", {
              pid: child.pid ?? -1,
              browser_version: this.browserVersion,
            });
            resolve();
          }
          return;
        }
        const id = m.get("id").int;
        if (id === null) return;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        const error = m.get("error").str;
        if (error !== null) {
          p.reject(new Error(error));
        } else {
          const result = (m.get("result").obj as { [k: string]: JSONValue }) ?? {};
          const failed = result.failed_requests;
          // Held here, not passed on: what reaches the agent is built by the
          // session layer out of what it takes, never inherited from a result.
          delete result.failed_requests;
          if (Array.isArray(failed)) {
            this.failedRequests = [...failed, ...this.failedRequests].slice(0, MAX_FAILED_REQUESTS);
          }
          p.resolve(result);
        }
      });

      child.on("exit", (code, signal) => {
        rl.close();
        const wasReady = ready;
        this.child = null;
        const reason = `browser server exited (code=${code}, signal=${signal})`;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new BrowserCrashedError(reason));
        }
        this.pending.clear();
        if (wasReady && !this.shuttingDown) {
          this.cfg.audit?.("browser_crashed", { code: code ?? -1 });
          this.onCrash?.();
        }
        if (!ready) {
          ready = true; // don't double-settle
          clearTimeout(startTimer);
          reject(
            new BrowserCrashedError(`${reason}: ${this.stderrTail.join("").slice(-500)}`),
          );
        }
      });

      child.on("error", (err) => {
        this.child = null;
        if (!ready) {
          ready = true;
          clearTimeout(startTimer);
          reject(new BrowserCrashedError(`browser server failed to spawn: ${err.message}`));
        }
      });
    });
  }

  private killGroup(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  }

  /** Graceful quit, then SIGTERM the group, then SIGKILL. Idempotent. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    try {
      child.stdin!.write(JSON.stringify({ id: this.nextId++, action: "quit" }) + "\n");
    } catch {
      /* stdin already closed */
    }
    if (!(await withTimeout(exited, 3000))) {
      this.killGroup("SIGTERM");
      if (!(await withTimeout(exited, 5000))) {
        this.killGroup("SIGKILL");
        await withTimeout(exited, 2000);
      }
    }
    this.child = null;
    this.cfg.audit?.("browser_stopped", {});
  }

  /** Allow a new session to start again after the circuit breaker tripped. */
  resetBreaker(): void {
    this.restartTimes = [];
    this.shuttingDown = false;
  }
}

function withTimeout(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    t.unref?.();
    void p.then(() => {
      clearTimeout(t);
      resolve(true);
    });
  });
}
