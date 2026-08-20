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
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
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
  /**
   * Parent of the per-grant profiles. The dir used for a given start is chosen
   * by `ensureReady`, one per approved origin set. Omit it (or start without a
   * key) and the browser runs with no persistent profile at all: a fresh cookie
   * jar every launch, which is what a bot-block reproduction needs.
   */
  profilesDir?: string;
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

/**
 * Push one path out of the page cache. Directories take a handle too, for the
 * entry. Not a power-cut guarantee on macOS: `fsync(2)` there does not flush
 * the drive's own write cache, and `F_FULLFSYNC` — which would — has no Node
 * binding. What this buys is the seconds-long writeback window, which is the
 * asymmetry that matters against a browser whose SQLite writes fsync too.
 */
async function fsync(target: string): Promise<void> {
  const handle = await fsp.open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_IN_WINDOW = 3;

export class BrowserHost {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private restartTimes: number[] = [];
  private stderrTail: string[] = [];
  private shuttingDown = false;
  /** Browser version reported by the ready line (empty until started). */
  browserVersion = "";
  /**
   * Top-level URLs the browser has shown since the session layer last looked.
   * Accumulated from EVERY response rather than read off one, because plenty
   * of them never reach the scope check: the owner's viewer polls straight
   * through `viewFrame`, and `locate`/`fill` are issued here rather than
   * through `command`. A popup reported on one of those would otherwise be
   * consumed and dropped, and the origin it touched never classified.
   */
  private pendingTouched: string[] = [];

  /** Set by the session layer: fires when a ready browser dies unexpectedly,
   * so the session over it can be closed out rather than left open forever. */
  onCrash?: () => void;

  /** Window mode of the current (or next) browser — a session may switch it. */
  private headedNow: boolean;
  /** Profile the next browser opens, one per approved origin set. */
  private profileKeyNow: string | null = null;
  /** The profile this browser is on, while it is still publishable. Cleared
   * the moment it stops being — a stray hop, a widening, an unexpected exit —
   * so null alone means "this jar is not going back under its grant". */
  private profile: { saved: string; live: string } | null = null;
  /** Grant the running browser opened for — null once it has been given up. */
  private startedKey: string | null = null;

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

  /** Everything the browser has shown since the last drain, and clear it. */
  drainTouched(): string[] {
    const touched = this.pendingTouched;
    this.pendingTouched = [];
    return touched;
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
  ensureReady(headed?: boolean, profileKey?: string | null): Promise<void> {
    this.headedNow = headed ?? this.cfg.headed === true;
    this.profileKeyNow = profileKey ?? null;
    return this.ensureStarted();
  }

  /**
   * Give up this session's profile: it can hold state for an origin the grant
   * does not name — a widening, or an action that landed out of scope — so it
   * must never be published back under that grant's name.
   *
   * A flag, not a file. The directory is already somewhere no grant can spell
   * (see profileDirForStart), so there is nothing to write, nothing to flush,
   * and no way for this to fail: the profile becomes reusable only by being
   * renamed back on a clean stop, and this is what stops that happening.
   *
   * What that replaced, and why: a durable `domo-abandoned` marker inside the
   * live directory. It had to be flushed before the widening it gated, could
   * fail on the volume it was protecting, needed opposite failure semantics on
   * the two paths that call it, and left the contaminated jar reusable when
   * its own cleanup ran. Making the directory unclaimable while it is live
   * retires all of that.
   */
  abandonProfile(): void {
    const profile = this.profile;
    if (!profile) return;
    this.profile = null;
    // The owner's record that this session's store will not be kept — it is
    // what an unexplained sign-out next session traces back to. Idempotent:
    // straying twice is still one retirement, because the second finds null.
    this.cfg.audit?.("browser_profile_abandoned", { profile: path.basename(profile.live) });
  }

  /**
   * Where the next browser keeps its cookies. A profile lives under the hash
   * of the grant that owns it — but only while nothing is using it. For the
   * life of a session it sits at `<key>.live-<id>`, a name no grant can spell,
   * so a jar can never be claimed by a later session on the strength of what
   * it was before this one touched it. `publishProfile()` puts it back, and
   * only for a browser that acknowledged an explicit quit inside the window
   * `shutdown()` waits before it starts signalling.
   *
   * The consequence, stated plainly: quitting the app with a session live, a
   * crash, or a teardown slower than that window leaves the profile
   * unpublished and that grant signs in again. The ordinary paths — close,
   * idle timeout, reopen, disconnect — all await the browser's stop, and a
   * real Camoufox teardown fits the window; the integration tier's
   * login-survives-its-grant case is what says so.
   */
  private async profileDirForStart(): Promise<string | null> {
    const root = this.cfg.profilesDir;
    const key = this.profileKeyNow;
    if (!root || !key) return null;
    fs.mkdirSync(root, { recursive: true });
    this.sweepUnpublished(root);
    const saved = path.join(root, key);
    const live = `${saved}.live-${crypto.randomUUID()}`;
    const claimed = fs.existsSync(saved);
    if (claimed) fs.renameSync(saved, live);
    else fs.mkdirSync(live, { recursive: true });
    try {
      // Durable before the browser opens it: were the rename lost to a crash
      // while the jar kept its old name, the next session on this grant would
      // claim a directory this one had been writing into.
      await fsync(root);
    } catch (error: unknown) {
      // Put it back. `this.profile` is not assigned yet, so leaving the only
      // copy of that grant's logins under a live name would hand it to the
      // next start's sweep — losing them to a flush that failed.
      if (claimed) fs.renameSync(live, saved);
      throw error;
    }
    this.profile = { saved, live };
    return live;
  }

  /**
   * Put the profile back under its grant. Only ever called for a browser that
   * acknowledged an explicit quit: an unexpected exit — a crash, a kill, the
   * process torn down at app quit — leaves the directory under its live name,
   * where nothing can claim it and the next start's sweep collects it.
   *
   * That asymmetry is the point. A browser that died may have been mid-request
   * to an origin the scope check never got to see, so the only safe reading of
   * "we do not know where it went" is "this jar does not go back".
   */
  private publishProfile(profile: { saved: string; live: string }): void {
    try {
      fs.renameSync(profile.live, profile.saved);
    } catch {
      /* stays unclaimable, and the next start sweeps it */
    }
  }

  /** Directories left live by a crash, or given up. Nothing can claim one, and
   * no browser is running on the way to a spawn, so they go. */
  private sweepUnpublished(root: string): void {
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return; // not created yet
    }
    for (const name of names) {
      if (!name.includes(".live-")) continue;
      // Best-effort: an undeletable profile is wasted disk, but throwing here
      // would abort the start, and three of those trip the circuit breaker.
      try {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
        this.cfg.audit?.("browser_profile_reaped", { profile: name });
      } catch {
        /* try again on the next start */
      }
    }
  }

  private async ensureStarted(): Promise<void> {
    // A running browser cannot be moved to another profile, so handing this
    // caller the one already open would put their grant's cookies in another
    // grant's jar — the thing the per-grant store exists to prevent. The
    // profile asked for wins: put the wrong one away and start the right one.
    // A session still holding the old browser learns the way it would from any
    // browser that goes away.
    if (this.child && this.profileKeyNow !== this.startedKey) {
      try {
        await this.shutdown();
      } finally {
        this.resetBreaker();
      }
    }
    if (this.child) return;
    if (this.starting) return this.starting;

    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restartTimes.length >= MAX_RESTARTS_IN_WINDOW) {
      throw new BrowserCrashedError(
        `browser crashed ${this.restartTimes.length} times in the last minute; giving up`,
      );
    }
    this.restartTimes.push(now);

    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
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
    const profileDir = await this.profileDirForStart();
    this.startedKey = this.profileKeyNow;
    const argv = [
      ...this.cfg.command,
      "--screenshots-dir",
      this.cfg.screenshotsDir,
      ...(profileDir ? ["--profile-dir", profileDir] : []),
      ...(this.headedNow ? ["--headed"] : []),
    ];
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group, so shutdown can kill Firefox children
    });
    this.child = child;
    this.stderrTail = [];

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
              // Which store this browser is on. A name is reused once the
              // profile that had it is reaped, so hashing the origins says
              // which name — not which jar. This does.
              profile: profileDir ? path.basename(profileDir) : null,
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
        // Successful frames carry it inside `result` (the server's envelope);
        // error frames carry it beside the message, since they have none.
        for (const src of [m.get("result").get("touched"), m.get("touched")]) {
          for (const u of src.arr ?? []) {
            if (typeof u === "string") this.pendingTouched.push(u);
          }
        }
        const error = m.get("error").str;
        if (error !== null) {
          p.reject(new Error(error));
        } else {
          p.resolve(m.get("result").obj as { [k: string]: JSONValue } ?? {});
        }
      });

      child.on("exit", (code, signal) => {
        rl.close();
        const wasReady = ready;
        this.child = null;
        this.startedKey = null;
        // shutdown() owns the decision when it is the one stopping the
        // browser; an exit nobody asked for publishes nothing.
        if (!this.shuttingDown) this.profile = null;
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
        this.startedKey = null;
        this.profile = null;
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
  /**
   * Ask the browser to quit and wait for it to say so. Written straight to the
   * child with its own pending entry rather than through `sendAction`, which
   * would run `ensureStarted()` — and that can decide the live browser is on
   * the wrong profile and call back into here.
   */
  private requestQuit(child: ChildProcess): Promise<boolean> {
    const id = this.nextId++;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
      }, 3000);
      timer.unref?.();
      this.pending.set(id, {
        resolve: () => resolve(true),
        reject: () => resolve(false),
        timer,
      });
      try {
        child.stdin!.write(JSON.stringify({ id, action: "quit" }) + "\n");
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(false); // stdin already closed; it will not be answering
      }
    });
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.shuttingDown = true;
      return;
    }
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    // Asked before the latch, so the answer comes back through the ordinary
    // pending map: publication turns on the browser having ACKNOWLEDGED the
    // quit, not on it having stopped soon after one was sent. A browser that
    // happened to die on its own inside the same few seconds is one whose last
    // moments nobody saw, and that jar is not publishable.
    const acknowledged = this.requestQuit(child);
    this.shuttingDown = true;
    const quitAnswered = await acknowledged;
    if (await withTimeout(exited, 3000)) {
      // Read now, not before the awaits: an action still in flight can have
      // discovered a stray popup and given the profile up in the meantime, and
      // a snapshot taken earlier would publish the jar it just retired.
      if (quitAnswered && this.profile) this.publishProfile(this.profile);
    } else {
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
