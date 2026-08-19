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
 * The most output one call may carry back.
 *
 * Reading output is synchronous — it walks buffers the child already filled —
 * and synchronous work of unbounded size is the one thing no call ceiling can
 * save us from: a timer that cannot run while the event loop is copying a
 * gigabyte fires after the answer was already too late. So the *work* is
 * bounded rather than merely raced. A caller wanting the rest asks again from
 * `nextSince`.
 */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface ExecResult {
  handle: string;
  running: boolean;
  exitCode: number | null;
  output: Buffer;
  /** Total bytes produced so far — not the length of `output`. */
  outputLength: number;
  /**
   * The offset just past `output`. Equal to `outputLength` when this slice
   * reached the end; less when the cap cut it short and there is more to fetch.
   */
  nextSince: number;
}

class OutputBuffer {
  private chunks: Buffer[] = [];
  private length = 0;
  exitCode: number | null = null;
  private waiters: (() => void)[] = [];

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  finish(exitCode: number): void {
    this.exitCode = exitCode;
    for (const w of this.waiters) w();
    this.waiters = [];
  }

  /**
   * At most `maxBytes` of output from `since`.
   *
   * Deliberately does NOT concatenate the whole buffer: the old version copied
   * every byte the command had ever produced on every poll, so a chatty command
   * made each `get_output` cost more than the last and blocked the event loop
   * while it did — with the call ceiling's timer sitting behind that copy,
   * unable to fire. This walks only the chunks the slice actually needs.
   */
  snapshot(
    since: number,
    maxBytes: number = MAX_OUTPUT_BYTES,
  ): { output: Buffer; total: number; nextSince: number; running: boolean; exitCode: number | null } {
    const total = this.length;
    const start = Math.min(Math.max(since, 0), total);
    const end = Math.min(start + Math.max(maxBytes, 0), total);
    const wanted: Buffer[] = [];
    let offset = 0;
    for (const chunk of this.chunks) {
      const chunkEnd = offset + chunk.length;
      if (chunkEnd > start && offset < end) {
        wanted.push(chunk.subarray(Math.max(start - offset, 0), Math.min(end - offset, chunk.length)));
      }
      offset = chunkEnd;
      if (offset >= end) break;
    }
    return {
      output: Buffer.concat(wanted),
      total,
      nextSince: end,
      running: this.exitCode === null,
      exitCode: this.exitCode,
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
}

/**
 * Runs approved commands under /usr/bin/sandbox-exec with a per-run generated
 * profile, buffering merged stdout+stderr for the get_output streaming path.
 */
export class Executor {
  private buffers = new Map<string, OutputBuffer>();

  constructor(public readonly scratchRoot: string) {
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
    });
    child.stdout.on("data", (chunk: Buffer) => buffer.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => buffer.append(chunk));
    child.on("error", () => buffer.finish(-1));
    child.on("close", (code, signal) => {
      buffer.finish(code ?? (signal ? -1 : 0));
    });

    await buffer.waitForExit(Math.max(args.waitMs, 0));
    const snap = buffer.snapshot(0);
    return {
      handle,
      running: snap.running,
      exitCode: snap.exitCode,
      output: snap.output,
      outputLength: snap.total,
      nextSince: snap.nextSince,
    };
  }

  output(handle: string, since: number, maxBytes: number = MAX_OUTPUT_BYTES): ExecResult {
    const buffer = this.buffers.get(handle);
    if (!buffer) throw new ExecutorError(`unknown output handle: ${handle}`);
    const snap = buffer.snapshot(since, maxBytes);
    return {
      handle,
      running: snap.running,
      exitCode: snap.exitCode,
      output: snap.output,
      outputLength: snap.total,
      nextSince: snap.nextSince,
    };
  }
}
