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
import { homeFamilyParents, homeFamilyRegex } from "./plowHome.js";

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

/**
 * An SBPL regex literal. `#"..."` is raw — a backslash reaches the regex engine
 * as a backslash, which is what lets `homeFamilyRegex` escape metacharacters —
 * so only the quote that would end the literal is escaped here.
 */
function regexLiteral(pattern: string): string {
  return '#"' + pattern.replace(/"/g, '\\"') + '"';
}

/**
 * The home-family patterns, over CANONICAL directories so they match the
 * physical paths seatbelt enforces against (`/private/...`, not `/...`).
 *
 * Two of them in the general case: beside this run's own home, and in app data,
 * where the packaged install and every other checkout keep theirs. A run
 * started with an explicit `DOMO_HOME` elsewhere moves its own home and nobody
 * else's, so the second is not optional.
 */
function canonicalizedFamilyRegexes(deviceHome: string, userHome: string): string[] {
  return homeFamilyParents(canonicalize(deviceHome), userHome).map((parent) =>
    homeFamilyRegex(canonicalize(parent)),
  );
}

export const SandboxProfile = {
  generate(args: {
    readPaths: string[];
    writePaths: string[];
    network: boolean;
    scratch: string;
    /** Home override for golden tests; defaults to the real home. */
    home?: string;
    /**
     * Plow Latch's own home (DOMO_HOME). REQUIRED: the profile grants a broad
     * read of the user's home so installed tools resolve, and DOMO_HOME lives
     * under `~/Library/Application Support/`, so without this every sandboxed
     * command could read `settings.json` — the relay credential, and the
     * `agentPurpose` the reviewer is handed as the owner's own words.
     */
    deviceHome: string;
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
    // The scratch directory is NOT in here. It is granted once, after the
    // DOMO_HOME deny below, because that is the grant that has to survive —
    // granting it here as well would put the same two lines in every profile
    // twice and leave the audit of a security-critical, frozen-fixture policy
    // reading as if either copy were load-bearing.
    const writable = [...args.writePaths, ...housekeeping].map((p) => canonicalize(p));
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
    // LAST, because SBPL is last-match-wins and this must beat every allow
    // above it — including the broad `(subpath home)` read, which otherwise
    // covers ~/Library/Application Support/Plow-Latch-*/app/settings.json.
    //
    // An agent that can read that file has the relay credential; one that can
    // write it sets `agentPurpose`, which the next review is handed as the
    // OWNER's description of what agents are for. Writing your own purpose
    // statement is writing your own permissions, and no approval can grant
    // that, so it is not a capability at all — it is a floor under them.
    //
    // The scratch directory lives inside that home and must survive: it is
    // re-allowed after the deny, which is what last-match-wins is for. It holds
    // one run's disposable working files and nothing else.
    // `file-read*`/`file-write*`, NOT `file*`. Measured, not assumed: with
    // `(deny file* …)` here, the earlier `(allow file-read* (subpath home))`
    // still won and `cat settings.json` printed the credential. Seatbelt does
    // not resolve this by position alone — an operation-specific allow outranks
    // a broader deny that comes after it, so the deny has to name the same
    // operations. A profile-text assertion would not have caught that; the
    // tests run the sandbox.
    //
    // TWO denies, because there are two kinds of home to close. The subpath is
    // this run's own DOMO_HOME, wherever it is — a throwaway root under a test's
    // temp directory included. The regex is the FAMILY: this Mac runs one home
    // per checkout, `Plow-Latch-<branch>` beside the packaged install's plain
    // `Plow-Latch`, and each is signed in for its own relay credential. Reading
    // the neighbour's `settings.json` takes a credential exactly as reading
    // one's own does, and a command's own output is how it would leave, so no
    // read or network capability has to be declared for it.
    const plowHome = quote(canonicalize(args.deviceHome));
    const family = canonicalizedFamilyRegexes(args.deviceHome, home)
      .map((r) => `(regex ${regexLiteral(r)})`)
      .join(" ");
    lines.push(`(deny file-read* (subpath ${plowHome}) ${family})`);
    lines.push(`(deny file-write* (subpath ${plowHome}) ${family})`);
    lines.push(`(allow file-read* (subpath ${quote(canonicalize(args.scratch))}))`);
    lines.push(`(allow file-write* (subpath ${quote(canonicalize(args.scratch))}))`);
    return lines.join("\n");
  },
};

export class ExecutorError extends Error {}

export interface ExecResult {
  handle: string;
  running: boolean;
  exitCode: number | null;
  output: Buffer;
  outputLength: number;
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

  snapshot(since: number): { output: Buffer; total: number; running: boolean; exitCode: number | null } {
    const all = Buffer.concat(this.chunks);
    const start = Math.min(Math.max(since, 0), all.length);
    return {
      output: all.subarray(start),
      total: all.length,
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

  onExit(cb: (exitCode: number) => void): void {
    if (this.exitCode !== null) {
      cb(this.exitCode);
      return;
    }
    this.waiters.push(() => cb(this.exitCode ?? -1));
  }
}

/**
 * Runs approved commands under /usr/bin/sandbox-exec with a per-run generated
 * profile, buffering merged stdout+stderr for the plow_get_output streaming path.
 */
export class Executor {
  private buffers = new Map<string, OutputBuffer>();

  /**
   * `deviceHome` is REQUIRED — no default. A construction site that forgot it
   * would build profiles that can read `settings.json`, and that must be a type
   * error rather than a quiet hole.
   */
  constructor(
    public readonly scratchRoot: string,
    private readonly deviceHome: string,
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
      deviceHome: this.deviceHome,
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
    };
  }

  /** Invoke cb when the run exits — immediately if it already has. */
  onExit(handle: string, cb: (exitCode: number) => void): void {
    const buffer = this.buffers.get(handle);
    if (!buffer) throw new ExecutorError(`unknown output handle: ${handle}`);
    buffer.onExit(cb);
  }

  output(handle: string, since: number): ExecResult {
    const buffer = this.buffers.get(handle);
    if (!buffer) throw new ExecutorError(`unknown output handle: ${handle}`);
    const snap = buffer.snapshot(since);
    return {
      handle,
      running: snap.running,
      exitCode: snap.exitCode,
      output: snap.output,
      outputLength: snap.total,
    };
  }
}
