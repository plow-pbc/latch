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
import path from "node:path";
import { canonicalizeAsync, isLexicallyWithin, JSONValue } from "@domo/protocol";
import {
  argvCandidates,
  candidatePaths,
  Errno,
  errnoFromHint,
  MAX_CANDIDATE_PATHS,
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
  /** Whether the path of interest lies inside what the owner approved for
   *  this operation. Only such a path is probed on disk; one outside is
   *  classified by name and can carry one verdict only, the bound. Null
   *  when no path was settled on. */
  path_approved: boolean | null;
  /** The path is approved, but a run that may still be alive could rewrite
   *  it, so it was classified by name and not opened. */
  probe_withheld: boolean;
  /** What the app itself got opening the path, outside any profile. Null
   *  when the path was not probed (not approved, withheld, or none). */
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
  /** Paths implicated, verbatim (one path per entry, spaces and all),
   *  canonical where the caller had them. A file op names one; a command
   *  names what it declared and its working directory. */
  paths: readonly string[];
  /** A command's argv, element by element: a word that is a path is kept
   *  whole, spaces and all. Candidates, not approval: a path in argv is
   *  probed only when a declared path contains it. */
  argv?: readonly string[];
  /** A command's working directory: a candidate, and an approval root when
   *  it is a specific folder — the owner's whole home is not one. */
  cwd?: string | null;
  /** Free text to mine for further paths. Split on whitespace, so a path
   *  with a space in it must go in `paths` or `argv`. */
  texts?: readonly string[];
  /** What the kernel said to an in-process file op: errno code, syscall,
   *  and the path it was about — the fields, never a sentence to parse. */
  error?: { code: string | null; syscall: string | null; path: string | null } | null;
  /** Roots a run that may still be alive could rewrite (its profile's
   *  writable roots), read LIVE, at the moment of deciding: a candidate under
   *  one is classified by name and never opened, since between deciding a
   *  path is approved and opening it, such a run can replace it with a link
   *  elsewhere, and this process — outside any seatbelt — would follow. */
  mutable?: () => readonly string[];
  /** Runs the probes with no new run able to register meanwhile (the
   *  executor's hold): the roots `mutable` reports are then the roots there
   *  are, for as long as a probe is out. */
  hold?: <T>(fn: () => Promise<T>) => Promise<T>;
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
  const parsed = {
    errno: (ctx.error?.code ?? null) as Errno | null,
    syscall: ctx.error?.syscall ?? null,
    path: ctx.error?.path ?? null,
  };
  const hint = stderrHint(ctx.stderr ?? "");
  const errno = parsed.errno ?? errnoFromHint(hint);

  // The paths worth asking about: what the caller named, what the error
  // named, and what the command line and its output named — in that order
  // of trust. Deduplicated AFTER `~` expansion: a path the caller named in
  // full and stderr repeated as `~/…` is one path, and must be probed once.
  // Where each candidate came from decides how much it is trusted: a path
  // the failure itself named outranks one the command line mentioned, which
  // outranks one the caller merely declared (a cwd, a read root).
  //
  // WHAT MAY BE TOUCHED. The declared paths are what the owner approved,
  // and they bound everything this battery does on disk: only a candidate
  // under one of them is canonicalized (a realpath walks the disk),
  // inspected, or opened as the app. A command's output is the command's
  // to write, and a line in it naming ~/Desktop/secret must not have this
  // process — outside any seatbelt — stat that file, open it (a folder
  // gate would raise the owner's consent dialog for something they never
  // approved), and hand back whether it exists. An undeclared candidate is
  // classified from its name alone: what the profile would allow at it,
  // whether it is under a gate or a SIP root. That is enough for the one
  // verdict it can carry — outside the approved bound.
  type Source = "error" | "argv" | "declared";
  // The Node error's path is this process's own argument echoed back — an
  // in-process file op names what it was asked to touch — so it is as
  // approved as the caller's paths. A working directory is, when it is a
  // folder of its own; the owner's home as cwd (the default) approves
  // nothing under it, or every path on the Mac would be fair game. A
  // command's argv and output are not approval at all: a path in a shell
  // string is exactly what a run would write to have this Mac touch it.
  //
  // The approval is a SNAPSHOT, taken before the run and never resolved
  // again: the caller's paths were canonicalized when the owner approved
  // them, and a command that has since replaced one with a symlink must not
  // have this battery follow it — resolving the root now would turn
  // "~/Plow/out is approved" into "wherever ~/Plow/out points now is". Only
  // candidates are resolved, and a candidate that resolves out of the
  // snapshot is outside it.
  const home = path.resolve(ownerHome);
  const cwd = ctx.cwd ? path.resolve(expandHome(ctx.cwd, ownerHome)) : null;
  const declared = [
    ...[...ctx.paths, ...(parsed.path ? [parsed.path] : [])].map((p) => path.resolve(expandHome(p, ownerHome))),
    ...(cwd !== null && cwd !== home ? [cwd] : []),
  ];
  const contained = (p: string) => declared.some((d) => isLexicallyWithin(p, d));
  // Asked every time, not once: the roots are whatever runs are alive NOW.
  const rewritable = (p: string) =>
    (ctx.mutable?.() ?? []).some((r) => isLexicallyWithin(p, path.resolve(expandHome(r, ownerHome))));
  const hold = ctx.hold ?? (<T>(fn: () => Promise<T>) => fn());
  const sourced: [string, Source][] = [
    ...(parsed.path ? [[parsed.path, "error"] as [string, Source]] : []),
    ...candidatePaths(ctx.stderr ? [ctx.stderr] : []).map((p): [string, Source] => [p, "error"]),
    ...argvCandidates(ctx.argv ?? []).map((p): [string, Source] => [p, "argv"]),
    ...candidatePaths(ctx.texts ?? []).map((p): [string, Source] => [p, "argv"]),
    ...ctx.paths.map((p): [string, Source] => [p, "declared"]),
    ...(ctx.cwd ? [[ctx.cwd, "declared"] as [string, Source]] : []),
  ];
  type Examined = {
    path: string;
    source: Source;
    /** Whether the disk was asked at all: only for an approved path. */
    probed: boolean;
    /** Approved, but not asked: a live run could rewrite it. */
    withheld: boolean;
    info: Awaited<ReturnType<HostProbes["inspect"]>> | undefined;
    open: OpenOutcome | null;
    gate: HostPermission | null;
    sip: boolean;
    grants: { read: boolean; write: boolean } | null;
  };
  // Everything from here to the probes' return runs under the executor's
  // hold: no run can register in between, so a root checked by name before
  // resolving, and again before opening, is checked against every writer
  // that can exist while the probe is out.
  const { candidates, bySource, examined } = await hold(async () => {
  const bySource = new Map<string, { source: Source; probe: boolean; withheld: boolean }>();
  for (const [raw, source] of sourced) {
    // Resolved by name first. A path inside the approval is then resolved
    // on disk — realpath reads links and metadata, opens nothing, raises
    // nothing — and a link that walks out of the approval is an undeclared
    // path after all. Inside the approval after resolving, it is opened
    // only if no live run could rewrite it meanwhile: nothing decided here
    // is still true by the time a probe opens a path under such a root.
    // A named path under a root a live run can rewrite is not resolved at
    // all: the run could redirect it while realpath walks, and the target
    // would come back in `paths_examined` — a guess at an unapproved path
    // confirmed by the very battery that refused to open it. Such a path
    // stays as named, withheld.
    const named = path.resolve(expandHome(raw, ownerHome));
    const stable = contained(named) && !rewritable(named);
    const canonical = stable ? await canonicalizeAsync(named) : named;
    const approved = contained(named) && contained(canonical);
    const probe = approved && stable && !rewritable(canonical);
    const withheld = approved && !probe;
    const known = bySource.get(canonical);
    if (known === undefined) bySource.set(canonical, { source, probe, withheld });
    else if (probe && !known.probe) { known.probe = true; known.withheld = false; }
  }
  const candidates = [...bySource.keys()].slice(0, MAX_CANDIDATE_PATHS);

  // Every candidate at once: each open-as-app probe runs to its own timeout
  // when a dialog is holding it, and eight of those in sequence would outrun
  // the call budget this runs inside of.
  const examined: Examined[] = await Promise.all(
    candidates.map(async (path) => {
      const decided = bySource.get(path)!;
      // The last look before the disk is touched.
      const probe = decided.probe && !rewritable(path);
      const withheld = decided.withheld || (decided.probe && !probe);
      const { source } = decided;
      const info = probe ? await probes.inspect(path) : undefined;
      // A path that is not there cannot be opened, but CREATING it is what a
      // refused write was trying to do, and that is the parent's business: a
      // consent dialog on the folder or a profile with no write grant there
      // is the answer, and the probe that finds it is the parent's.
      const open = !probe ? null : info !== null ? await probes.openAsApp(path) : await parentOpen(probes, path);
      return {
        path,
        source,
        probed: probe,
        withheld,
        info,
        open,
        gate: guardedPrefix(path, ownerHome),
        sip: sipProtected(path),
        grants: ctx.sandbox ? ctx.sandbox(path) : null,
      };
    }),
  );
  return { candidates, bySource, examined };
  });

  // The path of interest, by how much each fact says: one the app itself
  // could not open; else, on EPERM, one carrying the locked flag, which is
  // exactly what that errno means for it; else, for a sandboxed run, one the
  // profile would not have allowed — the failure's own path before the
  // command line's, and never a merely declared one, since a read-only cwd
  // is not what went wrong; else one the failure named; else one under a
  // gate; else the first. A command that touched three paths and was refused
  // on one is diagnosed on that one.
  //
  // The command line is consulted for a profile refusal only when the
  // failure named no path of its own: `/bin/sh: ~/x: Operation not
  // permitted` names ~/x, and the shell reporting it — read-only under any
  // profile, and under a SIP root besides — is not what went wrong.
  const profileDenied = (e: Examined) => e.grants !== null && (!e.grants.write || !e.grants.read);
  const locked = (e: Examined) => e.info?.flags.some((f) => f === "uchg" || f === "schg") === true;
  const named = examined.some((e) => e.source === "error");
  const chosen =
    examined.find((e) => e.probed && e.open !== "ok" && e.open !== "ENOENT") ??
    (errno === "EPERM" ? examined.find(locked) : undefined) ??
    (ctx.ranSandboxed ? examined.find((e) => e.source === "error" && profileDenied(e)) : undefined) ??
    (ctx.ranSandboxed && !named ? examined.find((e) => e.source === "argv" && profileDenied(e)) : undefined) ??
    examined.find((e) => e.source === "error") ??
    examined.find((e) => e.gate !== null) ??
    examined[0] ??
    null;

  const [fda, automation] = await Promise.all([
    probes.fullDiskAccess(),
    ctx.automationTarget ? probes.automationStatus(ctx.automationTarget) : Promise.resolve(null),
  ]);

  const grants = chosen?.grants ?? null;
  return {
    op: ctx.op,
    path: chosen ? tildeRelative(chosen.path, ownerHome) : null,
    paths_examined: examined.map((e) => tildeRelative(e.path, ownerHome)),
    path_approved: chosen ? chosen.probed || chosen.withheld : null,
    probe_withheld: chosen?.withheld ?? false,
    path_exists: chosen?.probed ? chosen.info !== null : null,
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

function expandHome(p: string, ownerHome: string): string {
  if (p === "~") return ownerHome;
  return p.startsWith("~/") ? ownerHome + p.slice(1) : p;
}

/** The parent's open outcome stands in for a missing path's: `ok` becomes
 *  `ENOENT` (the file really is just absent), anything else is the parent's
 *  own refusal or hang. */
async function parentOpen(probes: HostProbes, p: string): Promise<OpenOutcome> {
  const parent = path.dirname(p);
  if (parent === p) return "ENOENT";
  const open = await probes.openAsApp(parent);
  return open === "ok" ? "ENOENT" : open;
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

  // Missing is the verdict only when nothing says otherwise: a write refused
  // with EPERM leaves no file behind either, and that refusal is the story.
  if (errno === "ENOENT" || (errno === null && f.path_exists === false)) {
    evidence.push(`${where} does not exist`);
    return verdict("not_found", "confirmed", null);
  }
  if (f.path_exists === true) ruledOut.push("file missing");
  else if (f.path_exists === false) evidence.push(`${where} does not exist; the refusal is on creating it`);

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

    // A path outside what the owner approved was never probed, and needs
    // no probe: whatever else macOS might say about it, the run was not
    // allowed there, and declaring it is the agent's next move.
    if (f.ran_sandboxed && f.path_approved === false && (f.sandbox_allows_write === false || f.sandbox_allows_read === false)) {
      evidence.push(`${where} is not among the paths approved for this run, and the sandbox profile allows it nothing`);
      return verdict("outside_approved_bound", "confirmed", null);
    }

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

    // The app's attempt was withheld — the run could have rewritten the
    // path under it — so the location has to speak for itself.
    if (f.probe_withheld && f.tcc_guarded_prefix !== null) {
      evidence.push(`${where} was not opened by ${APP_DISPLAY_NAME} itself: a running command could rewrite it`);
      evidence.push(`${where} is under a location macOS guards (${PERMISSION_LABELS[f.tcc_guarded_prefix]})`);
      if (COVERED_BY_FULL_DISK_ACCESS.has(f.tcc_guarded_prefix) && f.full_disk_access_granted === true) {
        return verdict("unknown", "unknown", f.tcc_guarded_prefix);
      }
      return verdict("macos_permission", "likely", f.tcc_guarded_prefix);
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
