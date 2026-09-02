/**
 * The questions a diagnosis asks this Mac, behind one interface.
 *
 * Everything that touches the machine is here, and nothing else in
 * `hostGate/` does: `diagnose.ts` is a pure function over the answers, so a
 * test scripts the answers (`scriptedProbes`) and asserts the verdict without
 * a TCC-protected file in sight. The real implementation (`nodeProbes`) gets
 * its own small test against fixture paths — a readable file, a missing one,
 * a `chmod 000` one, and a FIFO that hangs an open the way a consent prompt
 * does.
 *
 * `openAsApp` is the discriminating probe, and it is a CHILD PROCESS rather
 * than an in-process `fs.open` for one reason: an open that a consent dialog
 * is holding does not fail, it parks the calling thread in the kernel until
 * someone on the Mac clicks. In-process that would pin one of libuv's four
 * threadpool threads for as long as nobody is home; a child is killed on a
 * timer and the hang becomes an answer ("hung"). TCC attributes a child to
 * the app that spawned it — the "responsible process", the same attribution
 * every sandboxed run relies on — so the child sees exactly the grants the
 * app has, and NOT the seatbelt profile a run had, which is the whole point.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fullDiskProbePaths, probeFullDiskAccess } from "./fullDiskAccess.js";
import { Errno, errnoFromHint, stderrHint } from "./errors.js";

/** What opening a path from the app itself came back with. */
export type OpenOutcome = "ok" | "hung" | Errno;

/**
 * What `AEDeterminePermissionToAutomateTarget` knows about one target app.
 * `target_not_running` is its own answer because the API can only decide
 * for a running target — a not-running Messages.app is "unknown", not "no".
 */
export type AutomationStatus = "granted" | "denied" | "not_asked" | "target_not_running" | "unknown";

/** The POSIX view of a path — what `stat` says, with the mode bits already
 *  resolved against this process's uid and groups. */
export interface PathInfo {
  isDirectory: boolean;
  readable: boolean;
  writable: boolean;
  /** macOS file flags (`uchg`, `schg`, …). Empty where there are none, or on
   *  a host that has no such flags. */
  flags: string[];
}

export interface HostProbes {
  /** `stat` and mode bits. Null for a path that does not exist. */
  inspect(path: string): Promise<PathInfo | null>;
  /** Open (or list) the path as the app — outside any seatbelt profile. */
  openAsApp(path: string): Promise<OpenOutcome>;
  /** Whether Full Disk Access is granted right now. */
  fullDiskAccess(): Promise<boolean>;
  /** Automation consent for one target, by bundle id or app name. */
  automationStatus(target: string): Promise<AutomationStatus>;
}

/** How long a probe child may take before its silence is the answer. Long
 *  enough for a slow disk, far shorter than any human answering a dialog. */
export const PROBE_TIMEOUT_MS = 3_000;

export interface NodeProbeOptions {
  /** The owner's real home, for the Full Disk Access probe paths. */
  ownerHome?: string;
  /** The compiled `host-permissions` helper, for Automation status. Absent
   *  (no Swift toolchain, non-Mac host): every Automation answer is unknown. */
  helperPath?: string | null;
  timeoutMs?: number;
  /** Override for tests; the real list is `fullDiskProbePaths(ownerHome)`. */
  fullDiskPaths?: string[];
}

function canAccess(mode: number, uid: number, gid: number, want: "r" | "w"): boolean {
  const me = process.getuid?.() ?? -1;
  const groups = new Set<number>([process.getgid?.() ?? -1, ...(process.getgroups?.() ?? [])]);
  const bit = want === "r" ? 4 : 2;
  if (me === 0) return true;
  if (uid === me) return (mode & (bit << 6)) !== 0;
  if (groups.has(gid)) return (mode & (bit << 3)) !== 0;
  return (mode & bit) !== 0;
}

/** `stat -f %Sf` names the flags; "-" means none. macOS only. */
async function fileFlags(path: string, timeoutMs: number): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  return new Promise((resolve) => {
    execFile("/usr/bin/stat", ["-f", "%Sf", "--", path], { timeout: timeoutMs }, (error, stdout) => {
      if (error) return resolve([]);
      const text = stdout.trim();
      resolve(text === "" || text === "-" ? [] : text.split(","));
    });
  });
}

/** The real probes. Every answer is a fresh read: macOS changes them behind
 *  the app's back (System Settings), and there is no event to invalidate on. */
export function nodeProbes(options: NodeProbeOptions = {}): HostProbes {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const fdaPaths = options.fullDiskPaths ?? fullDiskProbePaths(options.ownerHome);
  return {
    async inspect(path) {
      let info: Awaited<ReturnType<typeof fs.stat>>;
      try {
        info = await fs.stat(path);
      } catch {
        return null;
      }
      return {
        isDirectory: info.isDirectory(),
        readable: canAccess(info.mode, info.uid, info.gid, "r"),
        writable: canAccess(info.mode, info.uid, info.gid, "w"),
        flags: await fileFlags(path, timeoutMs),
      };
    },

    async openAsApp(path) {
      let isDirectory = false;
      try {
        isDirectory = (await fs.stat(path)).isDirectory();
      } catch (error: unknown) {
        const code = (error as { code?: unknown })?.code;
        // A stat refused by TCC (a guarded folder's contents) is an answer;
        // a stat that says the file is not there is too.
        if (typeof code === "string") return code;
        return "error";
      }
      // Reading a directory's entries is what trips a folder gate; reading one
      // byte is what trips a file's. `head` exits 0 on an empty file.
      const [cmd, args] = isDirectory
        ? ["/bin/ls", ["-A", "--", path]]
        : ["/usr/bin/head", ["-c", "1", "--", path]];
      return new Promise<OpenOutcome>((resolve) => {
        const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        let settled = false;
        const settle = (outcome: OpenOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(outcome);
        };
        // SIGKILL: a process parked in a guarded open has no handler to run.
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          settle("hung");
        }, timeoutMs);
        timer.unref?.();
        child.on("error", () => settle("error"));
        child.on("exit", (code) => {
          if (settled) return;
          if (code === 0) return settle("ok");
          settle(errnoFromHint(stderrHint(stderr)) ?? "error");
        });
      });
    },

    fullDiskAccess: () => probeFullDiskAccess(fdaPaths),

    async automationStatus(target) {
      const helper = options.helperPath ?? null;
      if (helper === null) return "unknown";
      return new Promise<AutomationStatus>((resolve) => {
        execFile(helper, ["--automation", target], { timeout: timeoutMs }, (error, stdout) => {
          if (error) return resolve("unknown");
          try {
            const status = (JSON.parse(stdout.trim()) as { status?: unknown }).status;
            resolve(
              status === "granted" || status === "denied" || status === "not_asked" || status === "target_not_running"
                ? status
                : "unknown",
            );
          } catch {
            resolve("unknown");
          }
        });
      });
    },
  };
}

/** What a scripted probe set answers, keyed by path (or target). Anything
 *  not scripted gets the "nothing wrong here" default. */
export interface ProbeScript {
  inspect?: Record<string, PathInfo | null>;
  openAsApp?: Record<string, OpenOutcome>;
  fullDiskAccess?: boolean;
  automation?: Record<string, AutomationStatus>;
}

/**
 * Probes whose answers a test writes down. Records every call, so a test can
 * also assert WHAT was asked — that a failure probed the path it named, or
 * that a success never probed at all.
 */
export function scriptedProbes(script: ProbeScript = {}): HostProbes & { calls: string[] } {
  const calls: string[] = [];
  const readable: PathInfo = { isDirectory: false, readable: true, writable: true, flags: [] };
  return {
    calls,
    async inspect(path) {
      calls.push(`inspect ${path}`);
      const scripted = script.inspect ?? {};
      return path in scripted ? scripted[path]! : readable;
    },
    async openAsApp(path) {
      calls.push(`openAsApp ${path}`);
      return script.openAsApp?.[path] ?? "ok";
    },
    async fullDiskAccess() {
      calls.push("fullDiskAccess");
      return script.fullDiskAccess ?? true;
    },
    async automationStatus(target) {
      calls.push(`automationStatus ${target}`);
      return script.automation?.[target] ?? "unknown";
    },
  };
}
