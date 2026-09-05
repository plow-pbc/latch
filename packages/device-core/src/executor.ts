/**
 * Sandbox profile generation + sandboxed execution — twin of
 * DomoDeviceCore/Executor.swift. The SBPL profile is never authored; it is
 * mechanically derived from the approved capability set (DESIGN.md §6) and
 * must be BYTE-IDENTICAL to the Swift generator (fixtures/sbpl.json).
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize, isLexicallyWithin } from "@domo/protocol";

const READ_BOILERPLATE = [
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
  "/opt",
  "/private/etc",
  "/private/var/db",
  "/private/var/select",
];

function quote(p: string): string {
  return '"' + p.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export const SandboxProfile = {
  generate(args: {
    readPaths: string[];
    writePaths: string[];
    network: boolean;
    appleEvents: boolean;
    scratch: string;
    /** Home override for golden tests; defaults to the real home. */
    home?: string;
  }): string {
    const lines: string[] = [
      "(version 1)",
      "(deny default)",
      "(allow process-fork)",
      "(allow process-exec)",
      "(allow process-info*)",
      "(allow signal (target children))",
      "(allow sysctl-read)",
      // TODO(v1.x): tighten to the specific services processes need.
      //
      // Before you do: the MCP manifest names specific macOS tools it promises
      // an agent can run, and every one of them resolves a service through
      // THIS line. `MACOS_TOOLING` in mcp-server/src/tools.ts is the single
      // list — the sole source of truth for which tools are named, each
      // verified to exit 0 under this profile as written. An allowlist that misses what
      // they need turns that copy into a guaranteed denial — the exact bug the
      // copy was rewritten to remove — so tightening here means re-running them
      // under the new profile and editing that constant in the same commit.
      "(allow mach-lookup)",
      "(allow file-read-metadata)",
      "(allow file-ioctl)",
      "(allow file-read* " +
        [
          ...READ_BOILERPLATE.map((p) => `(subpath ${quote(p)})`),
          '(literal "/")',
          '(literal "/private")',
          '(literal "/private/var")',
          '(literal "/private/tmp")',
          '(literal "/tmp")',
          '(literal "/var")',
          '(literal "/etc")',
          '(literal "/Users")',
          '(literal "/dev/null")',
          '(literal "/dev/urandom")',
          '(literal "/dev/random")',
          '(literal "/dev/zero")',
          '(literal "/dev/tty")',
          '(subpath "/dev/fd")',
        ].join(" ") +
        ")",
      '(allow file-write-data (literal "/dev/null") (literal "/dev/tty") (subpath "/dev/fd"))',
    ];
    const home = canonicalize(args.home ?? os.homedir());
    // Broad READ of the user's home so tools installed under it and their
    // configs/libraries resolve. Writes stay scoped below — reads are the safe
    // capability here, and network is off unless approved.
    lines.push(`(allow file-read* (subpath ${quote(home)}))`);
    const housekeeping = ["Library/Caches", ".cache", ".config", ".local/state", ".npm"].map(
      (p) => home + "/" + p,
    );
    // A run that may be killed for going silent gets nothing persistent to
    // write, because it can be shot mid-write and nobody rolls that back. The
    // reads it loses with them are covered by the broad home grant above,
    // wherever those five resolve under home.
    const writable = [args.scratch, ...args.writePaths].concat(
      isReapable(args) ? [] : housekeeping,
    );
    for (const p of writable.map((p) => canonicalize(p))) {
      lines.push(`(allow file-write* (subpath ${quote(p)}))`);
      lines.push(`(allow file-read* (subpath ${quote(p)}))`);
    }
    for (const p of args.readPaths.map((p) => canonicalize(p))) {
      lines.push(`(allow file-read* (subpath ${quote(p)}))`);
    }
    if (args.network) {
      lines.push("(allow network*)");
      lines.push("(allow system-socket)");
    } else {
      lines.push("(deny network*)");
    }
    if (args.appleEvents) lines.push("(allow appleevent-send)");
    return lines.join("\n");
  },
};

/**
 * What the profile `SandboxProfile.generate` would build from these arguments
 * allows at one path — the same decision, asked after the fact.
 *
 * This is how a diagnosis (hostGate/diagnose.ts) tells "our seatbelt said no"
 * from "macOS said no": the app can open the path itself, and this says the
 * profile the run had would not have. Kept beside the generator so the two
 * cannot drift; it reads the same lists, in the same order, with the same
 * `isReapable` housekeeping rule. Paths in and out are canonical — the
 * roots exactly as the generator saw them when the profile was made, never
 * resolved again here (a run that has since replaced an approved path with
 * a symlink would otherwise widen its own approval to the link's target),
 * and a caller passes the path it already resolved.
 *
 * Reads are deliberately the generator's own over-approximation: broad home,
 * the boilerplate roots, and the literal directory entries the profile lists
 * one by one. Anything not named is denied, which is the profile's
 * `(deny default)`.
 */
export function sandboxGrants(
  args: {
    readPaths: string[];
    writePaths: string[];
    network: boolean;
    appleEvents: boolean;
    scratch: string;
    home?: string;
  },
  target: string,
): { read: boolean; write: boolean } {
  const under = isLexicallyWithin;
  const home = canonicalize(args.home ?? os.homedir());
  const writable = writableRoots(args);
  const write = writable.some((root) => under(target, root));
  const readRoots = [...READ_BOILERPLATE, home, ...writable, ...args.readPaths, "/dev/fd"];
  const literals = new Set([
    "/", "/private", "/private/var", "/private/tmp", "/tmp", "/var", "/etc", "/Users",
    "/dev/null", "/dev/urandom", "/dev/random", "/dev/zero", "/dev/tty",
  ]);
  const read = write || literals.has(target) || readRoots.some((root) => under(target, root));
  return { read, write };
}

/**
 * The roots a profile lets a run write — and so everything a run, or a job
 * it left behind, could replace with a symlink while nobody is looking.
 * The diagnosis (hostGate/diagnose.ts) never opens a path under one by
 * name while the run that owns it may still be alive.
 */
export function writableRoots(args: {
  writePaths: string[];
  network: boolean;
  appleEvents: boolean;
  scratch: string;
  home?: string;
}): string[] {
  const home = canonicalize(args.home ?? os.homedir());
  const housekeeping = ["Library/Caches", ".cache", ".config", ".local/state", ".npm"].map(
    (p) => home + "/" + p,
  );
  return [args.scratch, ...args.writePaths].concat(isReapable(args) ? [] : housekeeping);
}

export class ExecutorError extends Error {}

/**
 * Whether a run may be killed for going silent — and, because it is the same
 * question, whether it may be given anywhere persistent to write.
 *
 * Both callers derive it from the run's own capabilities rather than being
 * told: a profile that could be built "reapable" for a run the timer will
 * never touch, or the reverse, is a contradiction neither could detect.
 */
function isReapable(args: {
  writePaths: string[];
  network: boolean;
  appleEvents: boolean;
}): boolean {
  // `appleEvents` joins writes and network as a side-effect capability: an
  // osascript send changes another app's state, so a silent run must not be
  // SIGKILLed at 15 minutes and reported failed after it has already sent.
  return args.writePaths.length === 0 && !args.network && !args.appleEvents;
}

/**
 * How long a run that has produced NOTHING may stay alive before it is killed.
 *
 * macOS blocks — it does not refuse — an unconsented open of another app's
 * data: the child parks in `__guarded_open_np` waiting on a consent decision,
 * and on a Mac whose owner is not sitting in front of it nobody ever answers.
 * Nothing here used to end such a run, so the job answered `running` for the
 * life of the app while an agent polled it, and the process leaked with it.
 *
 * The bound has three halves and needs all of them. A ceiling alone would kill
 * honest long work: output handles never expire, so a build still running
 * after an hour is retrievable and must survive. `has produced no output`
 * separates those — a child that has written nothing at all by now is not
 * about to start. And the run must have been approved for neither writes nor
 * network, because those are the runs that can be silently mid-work here, and
 * a truncated copy or a half-applied remote call is worse than the wait.
 *
 * Nothing here reads CPU or idle time: this Mac legitimately runs
 * near-zero-CPU silent commands (an `ssh` waiting on a remote host), so
 * idleness is not evidence of anything.
 *
 * Fifteen minutes is a chosen literal, not a number computed from another:
 * long enough that a slow-but-real command is never the one being killed,
 * short enough that a wedged one is reported rather than waited on forever.
 */
const REAP_AFTER_MS = 15 * 60_000;

/**
 * How long output already in flight has to arrive once the command has exited.
 *
 * Normally `close` follows `exit` immediately and this never fires. It exists
 * for the run whose backgrounded job inherited the stdout pipe and is still
 * holding it: the command is over, so the job settles on this instead of
 * waiting on a pipe nobody is going to close. Settling closes the pipes, so a
 * background job still writing to them is broken by that — which is why
 * `plow_run_command` tells an agent to redirect anything meant to outlive its
 * command.
 */
const STDIO_DRAIN_MS = 250;

/**
 * What the agent is told about a run this Mac killed. It leads with the fact,
 * and names the cause that produces this shape — a permission prompt nobody
 * answered — as the likely one rather than the certain one, because from here
 * a blocked open and a genuinely mute command look identical.
 */
export const REAPED_MESSAGE =
  "killed by this Mac: the command produced no output and never exited. " +
  "The usual cause is a macOS permission prompt waiting for the Mac's owner to " +
  "answer it — reading another app's data needs a grant this app may not have " +
  "yet. Tell the user; re-running will block the same way until they grant it.";

export interface ExecResult {
  handle: string;
  running: boolean;
  exitCode: number | null;
  output: Buffer;
  outputLength: number;
  /** True when this Mac killed the run rather than the command ending. */
  reaped: boolean;
}

class OutputBuffer {
  /** Every chunk in arrival order, tagged by stream, so one list serves both views. */
  private chunks: { buf: Buffer; stdout: boolean }[] = [];
  private length = 0;
  exitCode: number | null = null;
  reaped = false;
  private waiters: ((exitCode: number) => void)[] = [];

  append(buf: Buffer, stdout: boolean): void {
    this.chunks.push({ buf, stdout });
    this.length += buf.length;
  }

  /** Just what the command wrote to stdout, whole. */
  stdout(): Buffer {
    return Buffer.concat(this.chunks.filter((c) => c.stdout).map((c) => c.buf));
  }

  /** Whether the command has written anything at all — the reaper's guard. */
  get produced(): boolean {
    return this.length > 0;
  }

  finish(exitCode: number): void {
    // Once only. The reaper settles a run without waiting for `close`, so a
    // straggler's later `close` must not rewrite an outcome already reported
    // to the agent and written to the audit log.
    if (this.exitCode !== null) return;
    this.exitCode = exitCode;
    // The outcome is handed to each waiter rather than read back off the
    // buffer, so no branch of this seam is in a position to invent one.
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(exitCode);
  }

  snapshot(since: number): {
    output: Buffer;
    total: number;
    running: boolean;
    exitCode: number | null;
    reaped: boolean;
  } {
    const all = Buffer.concat(this.chunks.map((c) => c.buf));
    const start = Math.min(Math.max(since, 0), all.length);
    return {
      output: all.subarray(start),
      total: all.length,
      running: this.exitCode === null,
      exitCode: this.exitCode,
      reaped: this.reaped,
    };
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exitCode !== null) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  onExit(cb: (exitCode: number, reaped: boolean) => void): void {
    if (this.exitCode !== null) {
      cb(this.exitCode, this.reaped);
      return;
    }
    this.waiters.push((code) => cb(code, this.reaped));
  }
}

/** The one place a buffer snapshot becomes the result callers see. */
function shape(snap: ReturnType<OutputBuffer["snapshot"]>): Omit<ExecResult, "handle"> {
  return {
    running: snap.running,
    exitCode: snap.exitCode,
    output: snap.output,
    outputLength: snap.total,
    reaped: snap.reaped,
  };
}

/**
 * Runs approved commands under /usr/bin/sandbox-exec with a per-run generated
 * profile, buffering merged stdout+stderr for the plow_get_output streaming path.
 */
export class Executor {
  private buffers = new Map<string, OutputBuffer>();
  /** What each run's profile was built from, kept so a diagnosis can ask
   *  after the fact what that profile allowed (`grants`). */
  private profiles = new Map<string, Parameters<typeof sandboxGrants>[0]>();
  /** Each run's process group (it is spawned as a session leader, so the
   *  group is its pid): what `mutableRoots` asks about after the command
   *  itself has exited, since a job it backgrounded lives on in it. */
  private groups = new Map<string, number>();
  /** Diagnoses' probes in flight (hostGate/diagnose.ts `hold`). A run
   *  registers — its writable roots become known — only while none is: a
   *  probe decides by the roots it can see at that moment, and a run that
   *  appeared in between would be one it never saw, free to rewrite the
   *  path the probe is about to open. Registration waits, never the probe:
   *  a run is delayed by a probe's timeout at most. */
  private probesInFlight = 0;
  private probesIdle: Promise<void> = Promise.resolve();
  private releaseProbes: () => void = () => {};

  /** Run `fn` — a diagnosis's probes — with run registration held off. */
  async holdProbes<T>(fn: () => Promise<T>): Promise<T> {
    if (this.probesInFlight === 0) {
      this.probesIdle = new Promise((resolve) => { this.releaseProbes = resolve; });
    }
    this.probesInFlight += 1;
    try {
      return await fn();
    } finally {
      this.probesInFlight -= 1;
      if (this.probesInFlight === 0) this.releaseProbes();
    }
  }

  constructor(
    public readonly scratchRoot: string,
    /** Overridden only by tests, which cannot wait out the real window. */
    private readonly reapAfterMs: number = REAP_AFTER_MS,
    /**
     * Directories holding vendored provider CLIs, prepended to the child's
     * PATH so `gog` resolves to the binary this app ships rather than to
     * whatever the owner happens to have installed.
     *
     * Prepended rather than appended for that reason: the provider registry
     * matches on a bare `argv[0]`, so which binary that name reaches is a
     * security decision, not a convenience.
     */
    private readonly vendorDirs: readonly string[] = [],
  ) {
    fs.mkdirSync(scratchRoot, { recursive: true });
  }

  async run(args: {
    argv: string[];
    cwd?: string;
    readPaths: string[];
    writePaths: string[];
    network: boolean;
    appleEvents: boolean;
    waitMs: number;
    /**
     * Extra environment for the child, merged over the curated set below.
     *
     * This is how a vendored provider CLI receives its token: in the child's
     * environment and nowhere else. A token on the command line lands in the
     * calling agent's captured output and from there in a persisted
     * transcript, where it outlives the token by a long way — and unlike argv,
     * a process environment is not readable through `ps`.
     *
     * Merged OVER the curated set, so a provider cannot be given a PATH or a
     * HOME of its choosing by way of this parameter — those are set after it.
     */
    env?: Readonly<Record<string, string>>;
  }): Promise<ExecResult> {
    if (args.argv.length === 0) throw new ExecutorError("launch failed: empty argv");
    // No new writer while a diagnosis is deciding what it may open.
    while (this.probesInFlight > 0) await this.probesIdle;
    const handle = crypto.randomUUID().toUpperCase();
    const scratch = path.join(this.scratchRoot, handle);
    fs.mkdirSync(scratch, { recursive: true });

    // cwd must be readable for the process to even start; it was part of the
    // approved exec capability, so allowing it matches the approval.
    const workingDir = args.cwd !== undefined ? canonicalize(args.cwd) : scratch;
    // The vendor dirs are always readable, because a vendored CLI lives inside
    // the .app bundle rather than under the owner's home — the broad home
    // grant in the profile does not reach it, so without this the child cannot
    // even exec the binary its PATH just resolved.
    const reads = [...args.readPaths, ...this.vendorDirs, workingDir];

    // Frozen as the generator saw them: canonical now, and never resolved
    // again. A later `grants()` asks what THIS profile allowed, and a run
    // that has since swapped an approved path for a symlink must not have
    // the answer follow the link (sandboxGrants).
    const profileArgs = {
      readPaths: reads.map((p) => canonicalize(p)),
      writePaths: args.writePaths.map((p) => canonicalize(p)),
      network: args.network,
      appleEvents: args.appleEvents,
      scratch: canonicalize(scratch),
    };
    const profile = SandboxProfile.generate(profileArgs);
    this.profiles.set(handle, profileArgs);
    if (process.env.DOMO_DEBUG_SANDBOX) {
      process.stderr.write(`=== PROFILE ===\n${profile}\n=== ARGV ===\n${args.argv.join(" ")}\n`);
    }

    const realHome = os.homedir();
    const buffer = new OutputBuffer();
    this.buffers.set(handle, buffer);

    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, ...args.argv], {
      cwd: workingDir,
      env: {
        ...args.env,
        // Real home so tools and their configs resolve; TMPDIR stays in the
        // (writable, disposable) scratch dir; PATH includes the user bin dirs.
        // These come AFTER the caller's env deliberately: a provider supplies
        // its token, never the shape of the world its child runs in.
        PATH:
          [
            ...this.vendorDirs,
            `${realHome}/.local/bin`,
            `${realHome}/bin`,
            `${realHome}/.cargo/bin`,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
          ].join(":"),
        HOME: realHome,
        TMPDIR: scratch,
        LANG: "en_US.UTF-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, purely so the reaper below can take the whole
      // run. `sandbox-exec` execs into the approved argv, and that argv is
      // routinely a shell: `/bin/sh -c 'a && b'` does NOT exec, so signalling
      // one pid kills the shell and leaves the wedged descendant holding the
      // stdout pipe — which is the bug, not the fix.
      //
      // This is `setsid`, so a run also leaves the app's session and stops
      // receiving its terminal signals — a Ctrl-C on `just app` no longer
      // reaches one. Accepted knowingly: nothing here has ever killed live
      // children at quit (the packaged app has no terminal to signal it), so
      // the sweep that would is its own change, not a side effect of this one.
      detached: true,
    });
    if (child.pid !== undefined) this.groups.set(handle, child.pid);
    // A run ends when its COMMAND ends. `close` says something else — every
    // stdio pipe closed too — and a job the command backgrounded inherits
    // those pipes and can hold them open forever. Settling on `exit` is what
    // keeps "the command finished" from meaning "and nothing it started is
    // still around", which is not this Mac's promise to keep and was three
    // rounds of holes in one predicate when the reaper tried to keep it.
    let reaper: ReturnType<typeof setTimeout> | undefined;
    // Settling CLOSES the capture, on every path into it. A run that has been
    // answered must stop growing, and the read ends of its pipes must not stay
    // attached for the life of the app because something the command left
    // behind is still holding the write ends. That the capture closes is why
    // nothing downstream needs a guard against late output.
    const settle = (code: number) => {
      clearTimeout(reaper);
      // Answered first, closed second, both in one synchronous breath: nothing
      // can append between the two statements, and everything downstream that
      // asks "is this run still open?" — `abandon`'s kill above all — gets the
      // right answer for anything the destroys themselves emit. `finally`
      // because `finish` runs the `onExit` waiters: closing the capture is not
      // theirs to skip by throwing.
      try {
        buffer.finish(code);
      } finally {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    };
    child.on("error", () => settle(-1));
    child.on("exit", (code, signal) => {
      const outcome = code ?? (signal ? -1 : 0);
      // Output already written may still be in flight, so the usual `close`
      // remains the settling event — with a deadline, because a straggler
      // holding a pipe must not hold the agent with it. Output not delivered
      // by then is dropped: this deadline is the end of the run.
      const drain = setTimeout(() => settle(outcome), STDIO_DRAIN_MS);
      drain.unref?.();
      child.on("close", () => {
        clearTimeout(drain);
        settle(outcome);
      });
    });

    // Ending a run early ends its PROCESS too. Both paths that do it — the
    // reaper, and a capture that broke — answer the caller and disarm the
    // reaper as they go, so a run left alive on either would be alive,
    // unkillable and untracked: exactly what this whole change is against.
    //
    // The kill applies only while the run is still open, which makes this as
    // idempotent as the `settle` it ends with. After a run is answered its
    // group is not ours to signal: the pid may have been reaped and its pgid
    // reused, and a job that redirected both streams is one this Mac has
    // promised will outlive the run that started it.
    //
    // That guard shares the stream-error handler's untested status — the only
    // caller that reaches here after a run is answered — so the survivor test
    // in `executorReap.test.ts` pins the promise, not this line.
    const abandon = (code: number) => {
      if (buffer.exitCode === null && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone, or a group that no longer exists. Settling is what
          // the caller is owed either way.
        }
      }
      settle(code);
    };

    // What is left for the reaper is the one case `exit` cannot answer: a
    // command that never ends at all — and only where killing it can cost
    // nothing. A run that was approved to write or to reach the network can
    // be silently mid-work at the deadline: killing a large copy truncates
    // its destination, and killing a series of remote calls leaves them half
    // applied, neither of which anyone rolls back.
    //
    // What makes the other runs safe to kill is NOT that they declared no
    // writes — that alone was never enough, since every profile used to hand
    // out the housekeeping grant. It is that `isReapable` decided the profile
    // too: a run this timer can fire on was given nowhere persistent to write,
    // and the scratch it does have is deleted below. The two must stay one
    // decision. It is also the shape the observed failure had — a
    // `sqlite3 -readonly` blocked on a consent prompt.
    //
    // Say plainly what that costs, because there is no cancel affordance to
    // soften it: a wedged run with side-effect capability stays alive and
    // untracked, its `exec_start` unpaired, until someone kills the process
    // from a terminal. Issue #178 is the owner-facing way to end a run.
    //
    // SIGKILL rather than a polite SIGTERM —
    // it is wedged in a kernel call with nothing to clean up, and a handler
    // that never gets scheduled would only leave the same process on the
    // table. The group, not the pid, because `sandbox-exec` execs into the
    // approved argv and that argv is routinely a shell: `/bin/sh -c 'a && b'`
    // does NOT exec, so one signal kills the shell and leaves the wedged
    // descendant alive.
    if (isReapable(args)) {
      reaper = setTimeout(() => {
        if (buffer.exitCode !== null || buffer.produced) return;
        buffer.reaped = true;
        // `abandon` can only throw through an `onExit` waiter and the sole
        // registrant catches its own, so the `finally` is here to make the
        // deletion unskippable rather than because a throw is expected.
        try {
          abandon(-1);
        } finally {
          // The run is dead and its output is already in memory. Its scratch is
          // the one place it could have left half of something — `TMPDIR` points
          // there and it is the only writable path a reapable run has — so the
          // half goes with it.
          //
          // Async, and with retries. Scratch holds whatever the run was
          // writing, which is unbounded (the WhatsApp fallback copies an entire
          // archive through here), and a synchronous walk over that would stall
          // every other run's budget timer, the relay socket and the approval
          // window — the same reason file operations in this codebase are async
          // and size-capped. `maxRetries` is for the descendant still writing
          // as we walk: `kill` returns before the group is gone, and `force`
          // covers ENOENT, not the ENOTEMPTY of a file created mid-walk. The
          // empty callback is the last resort — a scratch that outlives its run
          // is issue #153's standing state, and nothing here waits on it.
          fs.rm(scratch, { recursive: true, force: true, maxRetries: 3 }, () => {});
        }
      }, this.reapAfterMs);
      reaper.unref?.();
    }

    // Optional throughout: a spawn that never got as far as its stdio — the
    // fd exhaustion this reaper exists to make rarer — leaves these null and
    // emits `error` on the next tick, where a throw is nobody's to catch.
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => buffer.append(chunk, stream === child.stdout));
      // A pipe error ENDS the run rather than being swallowed: the stream is
      // auto-destroyed either way, so capture has stopped, and reporting the
      // command's own `exit 0` over a silently truncated answer is the worse
      // of the two. It goes through `abandon` because answering the caller
      // disarms the reaper, and a wedged command that outlived its own
      // capture is precisely what must not survive that.
      //
      // Deliberately untested: reaching it needs a seam for injecting a
      // stream error, and this is not worth an injectable spawn.
      stream?.on("error", () => abandon(-1));
    }

    await buffer.waitForExit(Math.max(args.waitMs, 0));
    return { handle, ...shape(buffer.snapshot(0)) };
  }

  /**
   * What the profile this run had would allow at `path` — the question a
   * diagnosis asks to tell our own seatbelt's refusal from macOS's. Answered
   * from the arguments the profile was generated from, so the two agree by
   * construction.
   */
  grants(handle: string, path: string): { read: boolean; write: boolean } {
    const args = this.profiles.get(handle);
    if (!args) throw new ExecutorError(`unknown output handle: ${handle}`);
    return sandboxGrants(args, path);
  }

  /** What one run's profile lets it write (see `writableRoots`). */
  writableRoots(handle: string): string[] {
    const args = this.profiles.get(handle);
    return args ? writableRoots(args) : [];
  }

  /**
   * What every run that is still going — or anything a run left behind —
   * could write right now: the roots a diagnosis of anything, a file op
   * included, must not open by name. A command's exit is not the end of
   * its run's hands on the disk: a job it backgrounded keeps its process
   * group alive, and the group is asked (a signal 0 to it) rather than the
   * command's exit code.
   */
  mutableRoots(): string[] {
    const roots: string[] = [];
    for (const [handle, buffer] of this.buffers) {
      if (buffer.exitCode === null || this.groupAlive(handle)) roots.push(...this.writableRoots(handle));
    }
    return roots;
  }

  /** Whether any process of the run's group still exists. */
  private groupAlive(handle: string): boolean {
    const pid = this.groups.get(handle);
    if (pid === undefined) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error: unknown) {
      // ESRCH: no such group — every member is gone. Anything else (EPERM,
      // a member no longer ours) means something is still there.
      return (error as { code?: unknown })?.code !== "ESRCH";
    }
  }

  /** Invoke cb when the run exits — immediately if it already has. */
  onExit(handle: string, cb: (exitCode: number, reaped: boolean) => void): void {
    this.buffer(handle).onExit(cb);
  }

  output(handle: string, since: number): ExecResult {
    return { handle, ...shape(this.buffer(handle).snapshot(since)) };
  }

  /**
   * A run's stdout alone, whole — for the callers that PARSE a command's
   * answer (the gog fan-out, the calendar conflict probe) rather than show
   * it. `output` merges stderr in because the `plow_get_output` stream needs
   * one ordered transcript, and is sliced from `since`; a stdout slice at
   * that offset would mean nothing, so this is an accessor, not a field.
   */
  stdout(handle: string): Buffer {
    return this.buffer(handle).stdout();
  }

  private buffer(handle: string): OutputBuffer {
    const buffer = this.buffers.get(handle);
    if (!buffer) throw new ExecutorError(`unknown output handle: ${handle}`);
    return buffer;
  }
}
