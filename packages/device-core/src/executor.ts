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
import { canonicalize } from "@domo/protocol";

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
      // list; today it is mdfind, sips and pbcopy/pbpaste, each verified
      // to exit 0 under this profile as written. An allowlist that misses what
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
    const writable = [args.scratch, ...args.writePaths, ...housekeeping].map((p) =>
      canonicalize(p),
    );
    for (const p of writable) {
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
    return lines.join("\n");
  },
};

export class ExecutorError extends Error {}

/**
 * How long a run that has produced NOTHING may stay alive before it is killed.
 *
 * macOS blocks — it does not refuse — an unconsented open of another app's
 * data: the child parks in `__guarded_open_np` waiting on a consent decision,
 * and on a Mac whose owner is not sitting in front of it nobody ever answers.
 * Nothing here used to end such a run, so the job answered `running` for the
 * life of the app while an agent polled it, and the process leaked with it.
 *
 * The bound has two halves and needs both. A ceiling alone would kill honest
 * long work: output handles never expire, so a build still running after an
 * hour is retrievable and must survive. `has produced no output` is what
 * separates the two — a child that has written nothing at all by now is not
 * about to start. Nothing here reads CPU or idle time: this Mac legitimately
 * runs near-zero-CPU silent commands (an `ssh` waiting on a remote host), so
 * idleness is not evidence of anything.
 *
 * Fifteen minutes is a chosen literal, not a number computed from another:
 * long enough that a slow-but-real command is never the one being killed,
 * short enough that a wedged one is reported rather than waited on forever.
 */
export const REAP_AFTER_MS = 15 * 60_000;

/**
 * How long output already in flight has to arrive once the command has exited.
 *
 * Normally `close` follows `exit` immediately and this never fires. It exists
 * for the run whose backgrounded job inherited the stdout pipe and is still
 * holding it: the command is over, so the job settles on this instead of
 * waiting on a pipe nobody is going to close.
 */
export const STDIO_DRAIN_MS = 250;

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
  private chunks: Buffer[] = [];
  private length = 0;
  exitCode: number | null = null;
  reaped = false;
  private waiters: (() => void)[] = [];

  append(chunk: Buffer): void {
    // Same once-only rule as `finish`: a straggler still holding the pipe must
    // not grow the output of a job the agent has already been told is over.
    if (this.exitCode !== null) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
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
    for (const w of this.waiters) w();
    this.waiters = [];
  }

  snapshot(since: number): {
    output: Buffer;
    total: number;
    running: boolean;
    exitCode: number | null;
    reaped: boolean;
  } {
    const all = Buffer.concat(this.chunks);
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
    this.waiters.push(() => cb(this.exitCode ?? -1, this.reaped));
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

  constructor(
    public readonly scratchRoot: string,
    /** Overridden only by tests, which cannot wait out the real window. */
    private readonly reapAfterMs: number = REAP_AFTER_MS,
  ) {
    fs.mkdirSync(scratchRoot, { recursive: true });
  }

  async run(args: {
    argv: string[];
    cwd?: string;
    readPaths: string[];
    writePaths: string[];
    network: boolean;
    waitMs: number;
  }): Promise<ExecResult> {
    if (args.argv.length === 0) throw new ExecutorError("launch failed: empty argv");
    const handle = crypto.randomUUID().toUpperCase();
    const scratch = path.join(this.scratchRoot, handle);
    fs.mkdirSync(scratch, { recursive: true });

    // cwd must be readable for the process to even start; it was part of the
    // approved exec capability, so allowing it matches the approval.
    const workingDir = args.cwd !== undefined ? canonicalize(args.cwd) : scratch;
    const reads = [...args.readPaths, workingDir];

    const profile = SandboxProfile.generate({
      readPaths: reads,
      writePaths: args.writePaths,
      network: args.network,
      scratch,
    });
    if (process.env.DOMO_DEBUG_SANDBOX) {
      process.stderr.write(`=== PROFILE ===\n${profile}\n=== ARGV ===\n${args.argv.join(" ")}\n`);
    }

    const realHome = os.homedir();
    const buffer = new OutputBuffer();
    this.buffers.set(handle, buffer);

    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, ...args.argv], {
      cwd: workingDir,
      env: {
        // Real home so tools and their configs resolve; TMPDIR stays in the
        // (writable, disposable) scratch dir; PATH includes the user bin dirs.
        PATH:
          `${realHome}/.local/bin:${realHome}/bin:${realHome}/.cargo/bin` +
          ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
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
    // A run ends when its COMMAND ends. `close` says something else — every
    // stdio pipe closed too — and a job the command backgrounded inherits
    // those pipes and can hold them open forever. Settling on `exit` is what
    // keeps "the command finished" from meaning "and nothing it started is
    // still around", which is not this Mac's promise to keep and was three
    // rounds of holes in one predicate when the reaper tried to keep it.
    let reaper: ReturnType<typeof setTimeout>;
    const settle = (code: number) => {
      clearTimeout(reaper);
      buffer.finish(code);
    };
    child.on("error", () => settle(-1));
    child.on("exit", (code, signal) => {
      const outcome = code ?? (signal ? -1 : 0);
      // Output already written may still be in flight, so the usual `close`
      // remains the settling event — with a deadline, because a straggler
      // holding a pipe must not hold the agent with it.
      const drain = setTimeout(() => settle(outcome), STDIO_DRAIN_MS);
      drain.unref?.();
      child.on("close", () => {
        clearTimeout(drain);
        settle(outcome);
      });
    });

    // What is left for the reaper is the one case `exit` cannot answer: a
    // command that never ends at all. SIGKILL rather than a polite SIGTERM —
    // it is wedged in a kernel call with nothing to clean up, and a handler
    // that never gets scheduled would only leave the same process on the
    // table. The group, not the pid, because `sandbox-exec` execs into the
    // approved argv and that argv is routinely a shell: `/bin/sh -c 'a && b'`
    // does NOT exec, so one signal kills the shell and leaves the wedged
    // descendant alive.
    reaper = setTimeout(() => {
      if (buffer.exitCode !== null || buffer.produced) return;
      buffer.reaped = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone, or a group that no longer exists. Settling is what
          // the caller is owed either way.
        }
      }
      settle(-1);
    }, this.reapAfterMs);
    reaper.unref?.();

    child.stdout.on("data", (chunk: Buffer) => buffer.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => buffer.append(chunk));

    await buffer.waitForExit(Math.max(args.waitMs, 0));
    return { handle, ...shape(buffer.snapshot(0)) };
  }

  /** Invoke cb when the run exits — immediately if it already has. */
  onExit(handle: string, cb: (exitCode: number, reaped: boolean) => void): void {
    const buffer = this.buffers.get(handle);
    if (!buffer) throw new ExecutorError(`unknown output handle: ${handle}`);
    buffer.onExit(cb);
  }

  output(handle: string, since: number): ExecResult {
    const buffer = this.buffers.get(handle);
    if (!buffer) throw new ExecutorError(`unknown output handle: ${handle}`);
    return { handle, ...shape(buffer.snapshot(since)) };
  }
}
