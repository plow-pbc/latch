/**
 * Why an operation this Mac was approved to do did not happen — and what the
 * owner can do about it.
 *
 * The problem this solves: `EPERM` ("Operation not permitted") comes from at
 * least five places on a Mac — a TCC privacy gate, our own seatbelt profile,
 * System Integrity Protection, an immutable file flag, and a handful of
 * syscall-specific refusals — and one of TCC's failure modes is not an error
 * at all but an open that blocks until someone clicks a dialog on a screen
 * the owner may be nowhere near. An agent handed the bare errno cannot tell
 * the owner anything useful, and an agent that guesses will send them to the
 * wrong switch.
 *
 * So the error is only the TRIGGER. On a failure, `collectFacts` runs the
 * whole probe battery (`probes.ts`) and lays the answers out flat; `diagnose`
 * is a pure decision tree over those facts that names a cause, says how sure
 * it is, lists the evidence and what was ruled out, and carries the fixed
 * sentence the owner needs. Both halves are testable without macOS: the
 * facts are scripted, the tree is a function.
 *
 * The verdict and the facts BOTH reach the agent. The verdict is the app's
 * call — only the app can probe, and only the app knows whether the run was
 * inside a seatbelt profile — and a confirmed verdict is what the agent
 * relays. The facts are there for the `likely` and `unknown` verdicts, where
 * a model reasoning over them may do better than a tree that shipped once,
 * and for the audit trail that shows which branch was wrong when one is.
 */
import { JSONValue } from "@domo/protocol";
import {
  candidatePaths,
  Errno,
  errnoFromHint,
  parseNodeError,
  StderrHint,
  stderrHint,
} from "./errors.js";
import {
  COVERED_BY_FULL_DISK_ACCESS,
  guardedPrefix,
  HostPermission,
  PERMISSION_LABELS,
  sipProtected,
  tildeRelative,
} from "./guardedPaths.js";
import { AutomationStatus, HostProbes, OpenOutcome } from "./probes.js";

/** How the app names itself in the sentence the owner reads. */
export const APP_DISPLAY_NAME = "Plow Latch";

/**
 * What stopped the operation. `not_found` and `unknown` are verdicts too —
 * an honest "not found" or "could not tell" beats a wrong "grant Full Disk
 * Access" — but they are not host gates, so they do not make a result
 * `blocked` (see `isHostGate`).
 */
export type BlockedCause =
  /** A macOS privacy switch (TCC) the owner has not flipped for this app. */
  | "macos_permission"
  /** A consent dialog is open on the Mac's screen and nobody has answered. */
  | "prompt_waiting"
  /** Our own seatbelt profile: the path was not in the approved capability set. */
  | "outside_approved_bound"
  /** Ordinary ownership/mode bits. */
  | "posix_permissions"
  /** System Integrity Protection seals the path against every process. */
  | "sip_protected"
  /** The file carries the locked (`uchg`/`schg`) flag. */
  | "immutable_file"
  | "not_found"
  | "unknown";

export type Confidence = "confirmed" | "likely" | "unknown";

/** What the agent should do next — the machine field behind `owner_action`. */
export type Retry =
  | "after_owner_grants"
  | "after_owner_answers_prompt"
  | "with_declared_path"
  | "with_different_path"
  | "unknown";

/** Every probe's answer, flat and JSON-safe, for one failure. */
export interface HostFacts {
  op: "read" | "write" | "exec";
  /** The path the diagnosis settled on, `~`-relative. Null when the failure
   *  named none. */
  path: string | null;
  /** Every path that was examined, `~`-relative, in the order it was tried. */
  paths_examined: string[];
  path_exists: boolean | null;
  is_directory: boolean | null;
  posix_readable: boolean | null;
  posix_writable: boolean | null;
  immutable_flag: boolean | null;
  errno: Errno | null;
  syscall: string | null;
  stderr_hint: StderrHint | null;
  ran_sandboxed: boolean;
  sandbox_allows_read: boolean | null;
  sandbox_allows_write: boolean | null;
  /** What the app itself got opening the path, outside any profile. */
  app_process_open: OpenOutcome | null;
  /** The operation (or a probe of it) never returned. */
  hung: boolean;
  tcc_guarded_prefix: HostPermission | null;
  full_disk_access_granted: boolean | null;
  sip_protected: boolean;
  automation_target: string | null;
  automation_status: AutomationStatus | null;
}

export interface Diagnosis {
  cause: BlockedCause;
  confidence: Confidence;
  permission: HostPermission | null;
  evidence: string[];
  ruled_out: string[];
  /** The fixed sentence the agent relays to the owner verbatim. */
  owner_action: string | null;
  retry: Retry;
  /** Full Disk Access is the one grant macOS may not apply to a running
   *  process; the owner may have to quit and reopen the app. */
  requires_relaunch: boolean;
}

/** Whether a cause is a gate on this Mac — the causes that make a result
 *  `blocked` rather than a plain `error` with facts attached. */
export function isHostGate(cause: BlockedCause): boolean {
  return cause !== "not_found" && cause !== "unknown";
}

/** What the diagnosis is told about the failure, by whoever caught it. */
export interface FailureContext {
  op: "read" | "write" | "exec";
  /** Paths implicated, canonical where the caller had them. A file op names
   *  one; a command names what it declared and what appears in its argv. */
  paths: readonly string[];
  /** The Node error text, for an in-process file op. */
  errorMessage?: string | null;
  /** The command's captured output, for a run. */
  stderr?: string | null;
  ranSandboxed: boolean;
  /** For a sandboxed run: what the profile it ran under allows at a path. */
  sandbox?: ((path: string) => { read: boolean; write: boolean }) | null;
  /** The operation itself never returned. */
  hung?: boolean;
  /** The app the run was approved to send Apple events to, when it was. */
  automationTarget?: string | null;
}

/**
 * Run the whole battery and lay the answers out. Everything runs, even when
 * an early answer would settle the verdict: a complete, uniform fact set is
 * what makes the audit entries comparable and what a model can reason over.
 *
 * Bounded: at most `MAX_CANDIDATE_PATHS` paths, each probe on its own timer.
 */
export async function collectFacts(
  ctx: FailureContext,
  probes: HostProbes,
  ownerHome: string,
): Promise<HostFacts> {
  const parsed = parseNodeError(ctx.errorMessage ?? "");
  const hint = stderrHint(ctx.stderr ?? "");
  const errno = parsed.errno ?? errnoFromHint(hint);

  // The paths worth asking about: what the caller named, what the error
  // named, and what the command's output named — in that order of trust.
  // Deduplicated AFTER `~` expansion: a path the caller named in full and
  // stderr repeated as `~/…` is one path, and must be probed once.
  const candidates = [
    ...new Set(
      candidatePaths([
        ...ctx.paths,
        ...(parsed.path ? [parsed.path] : []),
        ...(ctx.stderr ? [ctx.stderr] : []),
      ]).map((p) => expandHome(p, ownerHome)),
    ),
  ];

  type Examined = {
    path: string;
    info: Awaited<ReturnType<HostProbes["inspect"]>>;
    open: OpenOutcome;
    gate: HostPermission | null;
    sip: boolean;
  };
  const examined: Examined[] = [];
  for (const path of candidates) {
    const [info, open] = await Promise.all([probes.inspect(path), probes.openAsApp(path)]);
    examined.push({ path, info, open, gate: guardedPrefix(path, ownerHome), sip: sipProtected(path) });
  }

  // The path of interest: the first one the app itself could not open, else
  // the first under a gate, else the first named. A command that touched
  // three paths and was refused on one is diagnosed on that one.
  const chosen =
    examined.find((e) => e.open !== "ok") ??
    examined.find((e) => e.gate !== null) ??
    examined[0] ??
    null;

  const [fda, automation] = await Promise.all([
    probes.fullDiskAccess(),
    ctx.automationTarget ? probes.automationStatus(ctx.automationTarget) : Promise.resolve(null),
  ]);

  const grants = chosen && ctx.sandbox ? ctx.sandbox(chosen.path) : null;
  return {
    op: ctx.op,
    path: chosen ? tildeRelative(chosen.path, ownerHome) : null,
    paths_examined: examined.map((e) => tildeRelative(e.path, ownerHome)),
    path_exists: chosen ? chosen.info !== null : null,
    is_directory: chosen?.info?.isDirectory ?? null,
    posix_readable: chosen?.info?.readable ?? null,
    posix_writable: chosen?.info?.writable ?? null,
    immutable_flag: chosen?.info ? chosen.info.flags.some((f) => f === "uchg" || f === "schg") : null,
    errno,
    syscall: parsed.syscall,
    stderr_hint: hint,
    ran_sandboxed: ctx.ranSandboxed,
    sandbox_allows_read: grants?.read ?? null,
    sandbox_allows_write: grants?.write ?? null,
    app_process_open: chosen?.open ?? null,
    hung: ctx.hung ?? false,
    tcc_guarded_prefix: chosen?.gate ?? null,
    full_disk_access_granted: fda,
    sip_protected: chosen?.sip ?? false,
    automation_target: ctx.automationTarget ?? null,
    automation_status: automation,
  };
}

function expandHome(path: string, ownerHome: string): string {
  if (path === "~") return ownerHome;
  return path.startsWith("~/") ? ownerHome + path.slice(1) : path;
}

/**
 * The decision tree. Pure, and ordered by how much each fact discriminates:
 * a hang says more than an errno, the app's own attempt says more than the
 * path's prefix, and a prefix says more than nothing.
 */
export function diagnose(f: HostFacts): Diagnosis {
  const evidence: string[] = [];
  const ruledOut: string[] = [];
  const where = f.path ?? "the path";
  const verdict = (
    cause: BlockedCause,
    confidence: Confidence,
    permission: HostPermission | null = null,
  ): Diagnosis => ({
    cause,
    confidence,
    permission,
    evidence,
    ruled_out: ruledOut,
    owner_action: ownerAction(cause, permission, f),
    retry: retryFor(cause),
    requires_relaunch: cause === "macos_permission" && permission === "full_disk_access",
  });

  // 1. Apple events are their own service with their own evidence, and none
  //    of the file facts bear on them.
  if (f.automation_target !== null) {
    const target = f.automation_target;
    if (f.automation_status === "denied") {
      evidence.push(`Automation consent for ${target} is denied for ${APP_DISPLAY_NAME}`);
      return verdict("macos_permission", "confirmed", "automation");
    }
    if (f.stderr_hint === "apple_event_not_permitted") {
      evidence.push(`the run reported an Apple event to ${target} was not permitted`);
      if (f.automation_status === "granted") {
        evidence.push("yet Automation consent for that target is granted — a hardened-runtime build without the automation entitlement fails this way");
        return verdict("unknown", "unknown", "automation");
      }
      if (f.automation_status === "not_asked") {
        evidence.push("macOS has never asked the owner about this target, so the send raised the consent dialog");
        return verdict("prompt_waiting", "likely", "automation");
      }
      if (f.automation_status === "target_not_running") {
        evidence.push(`${target} is not running, so consent cannot be checked`);
      }
      return verdict("macos_permission", "likely", "automation");
    }
    if (f.hung && f.automation_status === "not_asked") {
      evidence.push(`the run never returned and macOS has never asked the owner about ${target}`);
      return verdict("prompt_waiting", "confirmed", "automation");
    }
  }

  // 2. A hang is the one shape no errno produces: a consent dialog holding
  //    the open. Confirmed when the path is one macOS asks about.
  if (f.hung || f.app_process_open === "hung") {
    evidence.push(
      f.app_process_open === "hung"
        ? `opening ${where} from ${APP_DISPLAY_NAME} itself did not return`
        : "the operation never returned",
    );
    if (f.tcc_guarded_prefix !== null) {
      evidence.push(`${where} is under a folder macOS asks the owner about (${PERMISSION_LABELS[f.tcc_guarded_prefix]})`);
      return verdict("prompt_waiting", "confirmed", f.tcc_guarded_prefix);
    }
    return verdict("prompt_waiting", "likely", null);
  }

  // 3. From here on there is an errno — the operation's own, or the one the
  //    app's attempt returned.
  const probedErrno =
    f.app_process_open !== null && f.app_process_open !== "ok" && f.app_process_open !== "error"
      ? f.app_process_open
      : null;
  const errno = f.errno ?? probedErrno;

  if (f.stderr_hint === "sqlite_unable_to_open" && f.path_exists !== false) {
    // The WAL case the messaging skills document: sqlite needs to create
    // `-shm` beside the database, and a run approved to read is not approved
    // to write there. Reads as "no database"; is neither missing nor refused
    // by macOS.
    evidence.push(`sqlite could not open ${where}, which exists`);
    if (f.ran_sandboxed && f.sandbox_allows_write === false) {
      evidence.push("a WAL database needs its -shm index created beside it, and the sandbox profile allows no writes there");
      return verdict("outside_approved_bound", "likely", null);
    }
  }

  if (errno === "ENOENT" || f.path_exists === false) {
    evidence.push(`${where} does not exist`);
    return verdict("not_found", "confirmed", null);
  }
  if (f.path_exists === true) ruledOut.push("file missing");

  if (errno === "EROFS") {
    evidence.push(`${where} is on a read-only filesystem`);
    if (f.sip_protected) return verdict("sip_protected", "confirmed", null);
    return verdict("unknown", "unknown", null);
  }

  if (errno === "EACCES") {
    const bit = f.op === "write" ? f.posix_writable : f.posix_readable;
    evidence.push(`the kernel answered EACCES (ordinary permissions) for ${where}`);
    if (bit === false) {
      evidence.push("the file's mode and ownership deny the owner's account");
      return verdict("posix_permissions", "confirmed", null);
    }
    return verdict("posix_permissions", "likely", null);
  }

  if (errno === "EPERM" || (errno === null && f.app_process_open !== "ok" && f.app_process_open !== null)) {
    if (errno !== null) evidence.push(`the kernel answered ${errno} for ${where}`);
    if (f.immutable_flag === true) {
      evidence.push(`${where} carries the locked (uchg/schg) flag`);
      return verdict("immutable_file", "confirmed", null);
    }
    if (f.sip_protected) {
      evidence.push(`${where} is under a System Integrity Protection root`);
      return verdict("sip_protected", "confirmed", null);
    }
    ruledOut.push("locked file", "System Integrity Protection");

    if (f.ran_sandboxed && f.app_process_open === "ok") {
      evidence.push(`${APP_DISPLAY_NAME} itself can open ${where}, so macOS is not refusing it`);
      ruledOut.push("macOS permission");
      if (f.sandbox_allows_write === false) {
        evidence.push("the run's sandbox profile allows no writes at that path");
        return verdict("outside_approved_bound", "confirmed", null);
      }
      if (f.sandbox_allows_read === false) {
        evidence.push("the run's sandbox profile allows no reads at that path");
        return verdict("outside_approved_bound", "confirmed", null);
      }
      evidence.push("the run's sandbox profile allows the path too; the refusal was elsewhere");
      return verdict("unknown", "unknown", null);
    }

    if (f.app_process_open === "EPERM" || f.app_process_open === "EACCES") {
      evidence.push(`${APP_DISPLAY_NAME} itself is refused ${where} (${f.app_process_open}) outside any sandbox`);
      ruledOut.push("sandbox bound");
      if (f.tcc_guarded_prefix !== null) {
        evidence.push(`${where} is under a location macOS guards (${PERMISSION_LABELS[f.tcc_guarded_prefix]})`);
        if (COVERED_BY_FULL_DISK_ACCESS.has(f.tcc_guarded_prefix) && f.full_disk_access_granted === true) {
          evidence.push("Full Disk Access is granted, which covers that location");
          ruledOut.push("macOS permission (Full Disk Access is granted)");
          return verdict("unknown", "unknown", f.tcc_guarded_prefix);
        }
        if (f.full_disk_access_granted === false) evidence.push("Full Disk Access is not granted");
        return verdict("macos_permission", "confirmed", f.tcc_guarded_prefix);
      }
      evidence.push("the path is not under any location macOS is known to guard");
      return verdict("unknown", "unknown", null);
    }

    // No usable answer from the app's own attempt: fall back to the prefix.
    if (f.tcc_guarded_prefix !== null && f.full_disk_access_granted !== true) {
      evidence.push(`${where} is under a location macOS guards (${PERMISSION_LABELS[f.tcc_guarded_prefix]}) and Full Disk Access is not granted`);
      return verdict("macos_permission", "likely", f.tcc_guarded_prefix);
    }
    if (f.ran_sandboxed && (f.sandbox_allows_write === false || f.sandbox_allows_read === false)) {
      evidence.push("the run's sandbox profile does not allow the path");
      return verdict("outside_approved_bound", "likely", null);
    }
    return verdict("unknown", "unknown", null);
  }

  if (errno !== null) evidence.push(`the kernel answered ${errno} for ${where}`);
  else evidence.push("the failure carried no errno and no path this Mac could follow up on");
  return verdict("unknown", "unknown", null);
}

function retryFor(cause: BlockedCause): Retry {
  switch (cause) {
    case "macos_permission": return "after_owner_grants";
    case "prompt_waiting": return "after_owner_answers_prompt";
    case "outside_approved_bound": return "with_declared_path";
    case "posix_permissions":
    case "sip_protected":
    case "immutable_file":
    case "not_found": return "with_different_path";
    default: return "unknown";
  }
}

/**
 * The sentence the owner needs, written once per cause. Fixed strings by
 * construction — nothing from a command's output or an agent's argument is
 * interpolated, only the permission's System Settings label.
 */
export function ownerAction(
  cause: BlockedCause,
  permission: HostPermission | null,
  f: HostFacts,
): string | null {
  const app = APP_DISPLAY_NAME;
  switch (cause) {
    case "macos_permission": {
      if (permission === "automation") {
        const target = f.automation_target ?? "that application";
        return `In System Settings > Privacy & Security > Automation, allow ${app} to control ${target}.`;
      }
      if (permission === "full_disk_access" || permission === null) {
        return `In System Settings > Privacy & Security > Full Disk Access, turn on ${app}, then quit and reopen it.`;
      }
      const label = PERMISSION_LABELS[permission];
      const umbrella = COVERED_BY_FULL_DISK_ACCESS.has(permission)
        ? ` Granting ${app} Full Disk Access instead covers this and every other folder at once.`
        : "";
      return `In System Settings > Privacy & Security > ${label}, allow ${app}.${umbrella}`;
    }
    case "prompt_waiting":
      return (
        `A macOS permission dialog is open on the Mac's screen and only the owner, at the Mac, can answer it. ` +
        `Until they click Allow this stays blocked; if they click Don't Allow it will fail the same way next time until they change it in System Settings > Privacy & Security.`
      );
    case "outside_approved_bound":
      return (
        `The path was outside what was approved for this run. Ask again declaring it in write_paths (or read_paths); ` +
        `the owner will see the path in the approval.`
      );
    case "posix_permissions":
      return `The file's ownership or mode denies the owner's account. Fixing it means chown/chmod at the Mac; there is no switch in System Settings for this.`;
    case "sip_protected":
      return `System Integrity Protection seals this path on every Mac; nothing can be granted. Use a location under the owner's home instead.`;
    case "immutable_file":
      return `The file is locked (the macOS "Locked" flag). The owner can unlock it in Finder (Get Info > Locked) or with chflags nouchg.`;
    default:
      return null;
  }
}

/** The diagnosis and its facts as they ride a tool result and an audit line. */
export function diagnosisPayload(diagnosis: Diagnosis, facts: HostFacts): { [k: string]: JSONValue } {
  return {
    diagnosis: { ...diagnosis } as unknown as JSONValue,
    probes: { ...facts } as unknown as JSONValue,
  };
}
