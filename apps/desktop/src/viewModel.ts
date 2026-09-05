/**
 * Pure presentation logic — no Electron, no DOM — so the security-critical
 * mapping from a verified intent to what the human sees is unit-testable
 * (DESIGN.md §13.2: the approval window renders ONLY from the verified
 * canonical intent, never from agent-controlled markup).
 *
 * The renderer receives these plain view models over IPC and renders them as
 * text/structured nodes — it never eval()s or innerHTML's agent strings.
 */
import { Capability, capabilityDisplay, Intent, JSONValue, jv } from "@domo/protocol";

/**
 * Why a run this Mac killed was killed, in the owner's words. Every site that
 * renders it supplies its own verb, so the phrase carries none: the badge and
 * the timeline line for one run must agree without repeating each other.
 *
 * It names the cause because the owner is the only person who can answer the
 * permission prompt that usually causes it.
 */
const REAPED_REASON = "no output — a permission prompt may be waiting";

/**
 * The owner's words for what this Mac refused (device-core's hostGate/).
 * Short, for a badge; the timeline line carries the fixed owner sentence.
 */
function hostGateLabel(ev: ReturnType<typeof jv>): string {
  const cause = ev.get("cause").str ?? "";
  const permission = ev.get("permission").str;
  switch (cause) {
    case "macos_permission": return `needs a macOS permission${permission ? ` (${permissionWords(permission)})` : ""}`;
    case "prompt_waiting": return "a permission dialog is waiting on this Mac";
    case "outside_approved_bound": return "outside the approved paths";
    case "posix_permissions": return "file permissions";
    case "sip_protected": return "protected by macOS";
    case "immutable_file": return "locked file";
    default: return "blocked by this Mac";
  }
}

/**
 * The same refusal in two or three words, for the Status pill: "Blocked ·
 * Full Disk Access". The pill names the switch; the timeline line above
 * carries the sentence.
 */
function hostGateShort(ev: ReturnType<typeof jv>): string {
  const permission = ev.get("permission").str;
  switch (ev.get("cause").str ?? "") {
    case "macos_permission": return permission ? permissionWords(permission) : "macOS permission";
    case "prompt_waiting": return "dialog waiting";
    case "outside_approved_bound": return "outside approved paths";
    case "posix_permissions": return "file permissions";
    case "sip_protected": return "protected by macOS";
    case "immutable_file": return "locked file";
    default: return "by this Mac";
  }
}

/**
 * What a `denied_operation` was, by its `cause`: the sandbox bound is this
 * Mac refusing (Blocked, and the Blocked filter holds it); a file that is
 * missing, over the size limit, or not a file merely failed, and
 * must not send the owner looking for a path they never approved. A line
 * from before causes were recorded is the bound, which was all it could be.
 */
function deniedOperation(ev: ReturnType<typeof jv>): [string, BadgeTone, StatusKind] {
  switch (ev.get("cause").str ?? "outside_approved_bound") {
    case "outside_approved_bound": return ["Blocked · outside approved paths", "red", "blocked"];
    case "not_found": return ["Failed · not found", "amber", "failed"];
    // This app's own rules (the size limit, "not a file"): the timeline line
    // carries the sentence.
    default: return ["Failed", "amber", "failed"];
  }
}

/**
 * A "parked on a dialog" verdict is provisional: the owner clicking Allow
 * lets the run go on, and any exit of its own after it — clean or not —
 * says they did; only a reaped run was still parked. The block stays in
 * the log — it happened — but the row's outcome is the run's own end.
 */
function recovered(gate: JSONValue, exit: JSONValue | null): boolean {
  if (exit === null || jv(gate).get("cause").str !== "prompt_waiting") return false;
  return jv(exit).get("reaped").bool !== true;
}

/** System Settings' own words for a permission, for the badge. */
function permissionWords(permission: string): string {
  switch (permission) {
    case "full_disk_access": return "Full Disk Access";
    case "files_desktop": return "Desktop folder";
    case "files_documents": return "Documents folder";
    case "files_downloads": return "Downloads folder";
    case "files_icloud_drive": return "iCloud Drive";
    case "files_volumes": return "external volumes";
    case "automation": return "Automation";
    case "accessibility": return "Accessibility";
    case "screen_recording": return "Screen Recording";
    default: return permission;
  }
}

export interface ApprovalViewModel {
  intentId: string;
  agentDisplay: string;
  agentId: string;
  /** The high-level, UNVERIFIABLE goal/request text — shown as context only. */
  goal: string;
  request: string;
  planContext: string | null;
  /** The enforceable capability set — the source of the sandbox bound. */
  capabilities: { kind: string; display: string }[];
  /** Convenience flags for the UI. */
  needsNetwork: boolean;
  writesFiles: boolean;
  runsCommand: boolean;
  usesBrowser: boolean;
  fillsCredentials: boolean;
  /** Apple-event intents are non-idempotent mutations: the card offers no
   * Always Allow for them (the policy engine would refuse the rule anyway). */
  sendsAppleEvents: boolean;
  /** browser capability origins, for the card. */
  origins: string[];
  /** credential(fill) items with titles resolved ON-DEVICE (never from the
   * intent — agent-supplied titles would be spoofable). Title null = the
   * local vault could not resolve the id: a deny signal for humans. */
  credentialItems: { id: string; title: string | null; category: string | null }[];
}

/** Locally-resolved vault item titles, keyed by item id. */
export type CredentialTitles = Map<string, { title: string; category: string }>;

/** Build the approval card model from an already-verified intent. */
export function approvalViewModel(
  intent: Intent,
  credentialTitles?: CredentialTitles,
): ApprovalViewModel {
  const caps: Capability[] = intent.capabilities ?? [];
  const fillItems = caps.find((c) => c.kind === "credential" && c.access === "fill")?.items ?? [];
  const credentialItems = fillItems.map((id) => {
    const resolved = credentialTitles?.get(id) ?? null;
    return {
      id,
      title: resolved?.title ?? null,
      category: resolved?.category ?? null,
    };
  });
  const display = (c: Capability): string => {
    if (c.kind === "credential" && c.access === "fill" && credentialItems.length > 0) {
      const names = credentialItems.map((i) =>
        i.title !== null ? `'${i.title}' (${i.category ?? "?"})` : `${i.id} (unknown item)`,
      );
      // What the owner is actually granting: the value is typed here and never
      // handed back to the agent — but the agent is driving the page it lands
      // in, and can read that page. Saying "never leaves this Mac" would have
      // them approve against a promise the browser does not keep.
      return `Credentials: fill ${names.join(", ")} into approved sites (typed on this Mac; the agent can see the page it types into)`;
    }
    return capabilityDisplay(c);
  };
  return {
    intentId: intent.intentId,
    agentDisplay: intent.agentDisplay,
    agentId: intent.agentId,
    goal: intent.goal ?? "",
    request: intent.request,
    planContext: intent.planContext ?? null,
    capabilities: caps.map((c) => ({ kind: c.kind, display: display(c) })),
    needsNetwork: caps.some((c) => c.kind === "network" && c.allowed === true),
    writesFiles: caps.some((c) => c.kind === "fs.write"),
    runsCommand: caps.some((c) => c.kind === "process.exec"),
    usesBrowser: caps.some((c) => c.kind === "browser"),
    fillsCredentials: caps.some((c) => c.kind === "credential" && c.access === "fill"),
    sendsAppleEvents: caps.some((c) => c.kind === "apple_events" && c.allowed === true),
    origins: caps.find((c) => c.kind === "browser")?.origins ?? [],
    credentialItems,
  };
}

export type BadgeTone = "green" | "red" | "amber" | "blue" | "zinc";
export type StepState = "neutral" | "ok" | "bad";

export interface AuditStep {
  time: string;
  text: string;
  state: StepState;
}

/**
 * One logical operation — a group of related raw audit events. Mirrors the
 * Swift AuditActivity so the app shows one row per operation (not per raw
 * event), with a combined status and a per-event timeline in the detail pane.
 */
/** The Audit tab's two filters, one per column. Each folds the column's
 *  words into a few buckets an owner would actually pick:
 *   - decision: allowed (Allowed, Always allowed, Granted), denied (Denied,
 *     Rejected), unanswered (Pending, Not answered, Timed out — the owner
 *     said neither yes nor no).
 *   - status: completed (Completed, Revoked, Spawned, a clean Closed),
 *     running (Running, Browsing), blocked (a refusal by this Mac itself),
 *     failed (Failed, Killed, Error, Crashed, the failed browser states). */
export type DecisionKind = "allowed" | "denied" | "unanswered" | "none";
export type StatusKind = "completed" | "running" | "blocked" | "failed" | "none";

export interface AuditActivity {
  id: string;
  /** When the row starts, formatted for the table. */
  time: string;
  /** The same moment as the log wrote it (ISO 8601), for the date filter. */
  ts: string;
  /** When this Mac refused it, if it did — the moment the Capabilities tab
   *  counts by, so "Show in Audit" keys its cutoff on the block rather than
   *  on a request that may have started before the dismissal. */
  blockedAt: string | null;
  /** Who let this happen: "Allowed", "Always allowed", "Denied", "Timed out",
   *  "Rejected", "Pending", "Not answered", "Granted" — or "" for a row with no
   *  authorization step (a spawned agent, a browser session, an info line).
   *  Who decided it stays in `decidedBy`, for the detail pane. */
  decision: string;
  decisionTone: BadgeTone;
  /** What happened to the work: "Completed", "Running", "Blocked · Full Disk
   *  Access", "Failed · exit 1", "Killed · no output", "Error", the browser
   *  session states — or "" when nothing ran (denied, timed out, pending). */
  status: string;
  tone: BadgeTone;
  title: string;
  /** "command" | "file" | "access" | "agent" | "info" — drives the row icon. */
  kind: string;
  /** The Decision filter's bucket for this row. `none` for a row with no
   *  decision, which only "any" shows. */
  decisionKind: DecisionKind;
  /** The Status filter's bucket. `blocked` is this Mac itself refusing (a
   *  macOS permission, a waiting dialog, the sandbox bound) — its own bucket,
   *  because it is the one the Capabilities tab links into. `none` for a row
   *  with no outcome, which only "any" shows. */
  statusKind: StatusKind;
  command: string | null;
  agentId: string | null;
  agentDisplay: string | null;
  goal: string | null;
  intentId: string | null;
  exitCode: number | null;
  /** The macOS switch a block by this Mac named, in System Settings' words
   *  ("Full Disk Access") — what the Capabilities tab's "Show in Audit"
   *  searches for. Null for everything else. */
  permission: string | null;
  capabilities: string[];
  /** Human label for how the decision was made (auto-approve, adversarial,
   * you/asked, policy deny, always-allow rule), or null for non-decisions. */
  decidedBy: string | null;
  timeline: AuditStep[];
}

/** Friendly label for an intent_decision / grant `source`. */
export function decidedByLabel(source: string | null): string | null {
  switch (source) {
    case "approve": return "Auto-approved";
    case "adversarial": return "AI Reviewer";
    case "rule": return "Always-allow rule";
    case "plow_folder": return "Plow folder (auto-approved)";
    case "policy": return "Policy (deny mode)";
    // Not internal labels in the human's view: the operation was denied because
    // the reviewer could not run, not because anyone chose. One cannot be paid
    // for; the other was never configured.
    case "no_credits": return "AI Reviewer (out of credits)";
    case "no_reviewer": return "AI Reviewer (not configured)";
    case "reviewer_undecided": return "AI Reviewer (would not decide)";
    case "reviewer_unavailable": return "AI Reviewer (no usable verdict)";
    case "ask":
    case "prompt": return "You (asked)";
    // The deadline, not a person — see APPROVAL_SOURCE_EXPIRED.
    case "expired": return "No one (timed out)";
    case "error": return "Error while asking";
    default: return source;
  }
}

/**
 * Collapse the append-only event stream into activities: intent events grouped
 * by intentId, an access request paired with its decision (by agent), and
 * everything else standalone. Newest activity first. Port of the Swift
 * MainWindow group() + AuditActivity.
 */
export function auditActivities(events: JSONValue[]): AuditActivity[] {
  const order: string[] = [];
  const map = new Map<string, JSONValue[]>();
  const pendingAccess = new Map<string, string>(); // agent -> activity id
  const requests = new Map<string, JSONValue>(); // intentId -> its intent_received
  let counter = 0;
  const push = (id: string, e: JSONValue) => {
    if (!map.has(id)) {
      map.set(id, []);
      order.push(id);
    }
    map.get(id)!.push(e);
  };

  for (const e of events) {
    const ev = jv(e);
    const event = ev.get("event").str ?? "";
    // Lifecycle noise, never a row of its own: the device starting, and the
    // browser runtime starting/stopping under a session whose activity already
    // tells that story. (A crash IS surfaced, as its own activity.)
    if (event === "device_started" || event === "browser_started" || event === "browser_stopped")
      continue;
    const intentId = ev.get("intentId").str;
    const session = ev.get("session").str;
    if (event === "intent_received" && intentId !== null) requests.set(intentId, e);
    if (
      (event === "browser_session_opened" || event === "browser_session_extended") &&
      intentId !== null &&
      session !== null
    ) {
      // The open belongs to both stories: the intent row says how the session
      // was decided, and the session row must exist — and say "Browsing" —
      // from the moment the browser opens, not from its first command.
      //
      // A widening (`browser_session_extended`) belongs to both for the same
      // reason: the origins and items it added are part of what this session
      // was allowed to do, and reading them only off the opening intent
      // understates the session's actual bound to the owner.
      push(`intent:${intentId}`, e);
      // ...and the session row carries the request that authorised it, so it
      // can say WHO drove the browser and WHAT they were allowed to reach.
      // That was the reported bug: the row naming the agent held no browsing,
      // and the row holding the browsing named nobody. The decision is
      // deliberately NOT copied — it outranks the browser branch in
      // classifyActivity, and would replace the session's live status with
      // "Allowed once".
      const request = requests.get(intentId);
      if (request !== undefined) push(`browser:${session}`, request);
      push(`browser:${session}`, e);
    } else if (intentId !== null) {
      push(`intent:${intentId}`, e);
    } else if (session !== null) {
      // One activity per browser session, not one per command.
      push(`browser:${session}`, e);
    } else if (event === "access_request") {
      counter += 1;
      const id = `access:${counter}`;
      push(id, e);
      const agent = ev.get("agent").str;
      if (agent !== null) pendingAccess.set(agent, id);
    } else if (event === "access_decision") {
      const agent = ev.get("agent").str ?? "";
      const id = pendingAccess.get(agent);
      if (id !== undefined) {
        push(id, e);
        pendingAccess.delete(agent);
      } else {
        counter += 1;
        push(`access:${counter}`, e);
      }
    } else {
      counter += 1;
      push(`${event}:${counter}`, e);
    }
  }

  const activities = order.map((id) => buildActivity(id, map.get(id) ?? []));
  return activities.reverse(); // newest first for the table
}

function buildActivity(id: string, events: JSONValue[]): AuditActivity {
  const has = (event: string) => events.some((e) => jv(e).get("event").str === event);
  const entry = (event: string) => events.find((e) => jv(e).get("event").str === event) ?? null;
  const value = (event: string, key: string) => {
    const e = entry(event);
    return e ? (jv(e).get(key).str ?? null) : null;
  };

  const title = activityTitle(events, has, value);
  const { decision, decisionTone, decisionKind, status, tone, statusKind } = classifyActivity(events, has, entry);
  return {
    id,
    time: dayTime(jv(events[0]).get("ts").str ?? ""),
    ts: jv(events[0]).get("ts").str ?? "",
    blockedAt: value("host_permission_blocked", "ts"),
    decision,
    decisionTone,
    tone,
    status,
    title,
    kind: activityKind(events, has, value),
    decisionKind,
    statusKind,
    command: activityCommand(entry, value),
    agentId:
      value("intent_received", "agent") ??
      value("access_request", "agent") ??
      value("access_decision", "agent") ??
      value("agent_spawned", "agent"),
    // Newer entries carry the relay-asserted name; `access_request.display` is
    // the pre-relay shape, kept because the audit log is append-only and old
    // entries are still on disk.
    agentDisplay: value("intent_received", "agent_name") ?? value("access_request", "display"),
    goal:
      value("intent_received", "goal") ??
      value("access_request", "goals") ??
      value("agent_spawned", "goal"),
    intentId: jv(events[0]).get("intentId").str,
    exitCode: entry("exec_end") ? jv(entry("exec_end")!).get("exit_code").int : null,
    permission: (() => {
      const key = value("host_permission_blocked", "permission");
      return key === null ? null : permissionWords(key);
    })(),
    // Every request in this row, not just the first: a session that was
    // widened carries the opening intent AND each `browser_request` that
    // extended it, and showing only the first understates to the owner what
    // their browser was actually allowed to reach.
    capabilities: [
      ...new Set(
        events
          .filter((e) => jv(e).get("event").str === "intent_received")
          .flatMap((e) =>
            (jv(e).get("capabilities").arr ?? []).filter((c): c is string => typeof c === "string"),
          ),
      ),
    ],
    decidedBy: decidedByLabel(value("intent_decision", "source")),
    timeline: events.map(describeStep),
  };
}

function activityTitle(
  events: JSONValue[],
  has: (e: string) => boolean,
  value: (e: string, k: string) => string | null,
): string {
  const request = value("intent_received", "request");
  if (events.some((e) => (jv(e).get("event").str ?? "").startsWith("browser_"))) {
    // Where the browser actually went, not what was asked for — and never the
    // blank staging page every session opens on, which titled real sessions
    // "Browsing — about:blank" and told the owner nothing.
    const url = [...events]
      .reverse()
      .map((e) => (jv(e).get("event").str === "browser_navigated" ? jv(e).get("url").str : null))
      .find((u): u is string => u !== null && u !== "" && u !== "about:blank");
    if (url !== undefined) return `Browsing — ${url}`;
    return request ?? "Browser session";
  }
  if (request !== null) return request;
  if (has("credential_metadata") && value("credential_metadata", "session") === null) {
    const item = value("credential_metadata", "item");
    return item !== null ? `Credential fields read — ${item}` : "Credential list read";
  }
  if (has("access_request") || has("access_decision")) {
    return `Access — ${value("access_request", "display") ?? "agent"}`;
  }
  if (has("connector_connected")) {
    return `Connected Google account ${value("connector_connected", "account") ?? ""}`.trim();
  }
  if (has("connector_disconnected")) {
    return `Disconnected Google account ${value("connector_disconnected", "account") ?? ""}`.trim();
  }
  if (has("connector_default_changed")) {
    return `Made Google account ${value("connector_default_changed", "account") ?? ""} the default`;
  }
  if (has("activation_session_cleanup")) return "Activation session cleanup";
  if (has("agent_spawned")) return "Agent spawned";
  if (has("exec_end")) return "Command finished";
  return jv(events[0]).get("event").str ?? "Activity";
}

/**
 * Two readings of one operation — one tree, so the cells and the filters
 * cannot drift apart.
 *
 * `decision` is the authorization: who let this happen (or refused it).
 * `status` is the outcome: what happened to the work afterwards. They are
 * separate columns because they are separate facts — an approved command
 * can still be blocked by this Mac, and a denied one never ran at all — and
 * because the usual row is "Allowed / Completed", so a Status cell that says
 * anything else is the one that catches the eye. Either is "" when it does
 * not apply: a denied request has no outcome, a spawned agent no decision.
 * Each carries its filter bucket (`DecisionKind`, `StatusKind`) beside it.
 */
interface Classification {
  decision: string;
  decisionTone: BadgeTone;
  decisionKind: DecisionKind;
  status: string;
  tone: BadgeTone;
  statusKind: StatusKind;
}

const NO_DECISION = { decision: "", decisionTone: "zinc" as BadgeTone, decisionKind: "none" as DecisionKind };
const NO_STATUS = { status: "", tone: "zinc" as BadgeTone, statusKind: "none" as StatusKind };

/** A row that is a decision and nothing more: nothing ran. */
function decided(decision: string, decisionTone: BadgeTone, decisionKind: DecisionKind): Classification {
  return { decision, decisionTone, decisionKind, ...NO_STATUS };
}
/** A row that is an outcome with no decision of its own. */
function outcome(status: string, tone: BadgeTone, statusKind: StatusKind): Classification {
  return { ...NO_DECISION, status, tone, statusKind };
}

function classifyActivity(
  events: JSONValue[],
  has: (e: string) => boolean,
  entry: (e: string) => JSONValue | null,
): Classification {
  if (entry("intent_rejected")) return decided("Rejected", "red", "denied");
  const cleanup = entry("activation_session_cleanup");
  if (cleanup) {
    const result = jv(cleanup).get("outcome").str;
    if (result === "revoked") return outcome("Revoked", "green", "completed");
    if (result === "failed") return outcome("Failed", "red", "failed");
    // Nothing was done, so no bucket claims it.
    return outcome("Skipped", "zinc", "none");
  }
  if (has("access_request") || has("access_decision")) {
    const d = entry("access_decision");
    if (d) {
      const ok = jv(d).get("approved").bool ?? false;
      return ok ? decided("Granted", "green", "allowed") : decided("Denied", "red", "denied");
    }
    return decided("Pending", "zinc", "unanswered");
  }
  if (
    has("connector_connected") ||
    has("connector_disconnected") ||
    has("connector_default_changed")
  ) {
    return outcome("Completed", "green", "completed");
  }
  if (has("agent_spawned")) return outcome("Spawned", "blue", "completed");
  // The decision outranks any browser events riding in the intent's group: a
  // browser_open/browser_request row says how it was decided, and the live
  // browsing state belongs to the session's own activity.
  const dec = entry("intent_decision");
  if (dec) {
    const decision = jv(dec).get("decision").str ?? "";
    if (decision === "deny") {
      // The deadline denying is a timeout, not a refusal (approvalStore.ts) —
      // the audit must not dress it up as one, in the cell or the filter.
      if (jv(dec).get("source").str === "expired") return decided("Timed out", "amber", "unanswered");
      return decided("Denied", "red", "denied");
    }
    const allowed = {
      decision: decision === "always_allow" ? "Always allowed" : "Allowed",
      decisionTone: "green" as BadgeTone,
      decisionKind: "allowed" as DecisionKind,
    };
    const ran = (status: string, tone: BadgeTone, statusKind: StatusKind): Classification =>
      ({ ...allowed, status, tone, statusKind });
    // A block by this Mac itself outranks the run's exit code and the
    // reaper's verdict: the owner is the one person who can flip the switch,
    // and "Failed · exit 1" would hide that from them. Amber, like a killed
    // run, because nothing here was refused BY anyone.
    const gate = entry("host_permission_blocked");
    if (gate && !recovered(gate, entry("exec_end"))) return ran(`Blocked · ${hostGateShort(jv(gate))}`, "amber", "blocked");
    // The sandbox refusing is this Mac refusing too: the word is Blocked, so
    // the Blocked filter holds it. Red, not amber: the bound was the owner's.
    const denied = entry("denied_operation");
    if (denied) return ran(...deniedOperation(jv(denied)));
    if (has("exec_error") || has("tool_error")) return ran("Error", "red", "failed");
    const ee = entry("exec_end");
    if (ee) {
      // A run this Mac killed is not a command that failed, and the owner is
      // the one person who can clear what usually wedges it — an unanswered
      // permission prompt. "Failed · exit -1" would hide that from them; the
      // timeline line says what probably happened.
      if (jv(ee).get("reaped").bool === true) return ran("Killed · no output", "amber", "failed");
      const code = jv(ee).get("exit_code").int ?? -1;
      if (code !== 0) return ran(`Failed · exit ${code}`, "amber", "failed");
    } else if (has("exec_start")) {
      // Started and not yet ended: still approved, still in flight.
      return ran("Running", "blue", "running");
    }
    return ran("Completed", "green", "completed");
  }
  if (events.some((e) => (jv(e).get("event").str ?? "").startsWith("browser_"))) {
    const closed = entry("browser_session_closed");
    // A crash outranks everything the session accumulated before it. Ranked
    // any lower, a session that hit a scope block — or was refused by the site
    // — and then died would wear the milder of two true badges.
    if (jv(closed ?? null).get("reason").str === "crashed" || has("browser_crashed")) {
      return outcome("Crashed", "red", "failed");
    }
    if (has("browser_cookie_merge_failed")) return outcome("Closed · sign-ins not saved", "amber", "failed");
    if (has("credential_fill_failed")) {
      return closed ? outcome("Closed · fill failed", "amber", "failed") : outcome("Fill failed", "amber", "failed");
    }
    // The page would not let a filled secret stay hidden on screen, so the
    // agent was refused a look at it. The owner should see that as plainly as a
    // failed fill: it means a credential of theirs is sitting legible on a page
    // their agent is working in.
    if (has("credential_mask_failed")) {
      return closed ? outcome("Closed · mask failed", "amber", "failed") : outcome("Mask failed", "amber", "failed");
    }
    if (has("credential_denied") || has("browser_scope_violation")) {
      // "failed", not "completed": the cage refused the agent something, which
      // is the first thing an owner scanning for trouble filters for. The
      // amber word already said so; the bucket disagreed once, and the bucket
      // is what the filter reads.
      return closed ? outcome("Closed · scope blocks", "amber", "failed") : outcome("Scope blocked", "amber", "failed");
    }
    // The page's own server refused what the agent asked it to do — ranked
    // under a crash and a scope block, both stronger claims about the session,
    // but well above "Browsing".
    if (events.some((e) => (jv(e).get("failed_requests").arr ?? []).length > 0)) {
      return closed
        ? outcome("Closed · requests refused", "amber", "failed")
        : outcome("Requests refused", "amber", "failed");
    }
    if (closed) return outcome("Closed", "zinc", "completed");
    return outcome("Browsing", "green", "running");
  }
  // A vault metadata read carries no intent and no session, so it stands
  // alone — and it is recorded only after the broker answered, so by the time
  // it is on disk the operation is already over. (The session-scoped twin of
  // this event is handled with its browser session above.)
  const vaultRead = entry("credential_metadata");
  if (vaultRead && jv(vaultRead).get("session").str === null) {
    return outcome("Completed", "green", "completed");
  }
  const denied = entry("denied_operation");
  if (denied) return outcome(...deniedOperation(jv(denied)));
  // A handle-only block from a deferred run whose end outlived its intent's
  // row: the gate is still the story.
  const gate = entry("host_permission_blocked");
  if (gate && !recovered(gate, entry("exec_end"))) return outcome(`Blocked · ${hostGateShort(jv(gate))}`, "amber", "blocked");
  // A handle-only exec_end from an old log: a deferred run's end recorded
  // without its intent. The exit code is the whole story.
  const ee = entry("exec_end");
  if (ee) {
    if (jv(ee).get("reaped").bool === true) return outcome("Killed · no output", "amber", "failed");
    const code = jv(ee).get("exit_code").int ?? -1;
    return code === 0 ? outcome("Completed", "green", "completed") : outcome(`Failed · exit ${code}`, "amber", "failed");
  }
  if (has("approval_abandoned")) return decided("Not answered", "zinc", "unanswered");
  // Only an undecided intent is genuinely pending; anything else unrecognized
  // is a record, not an operation in flight.
  if (has("intent_received")) return decided("Pending", "zinc", "unanswered");
  return outcome("Info", "zinc", "none");
}

function activityKind(
  events: JSONValue[],
  has: (e: string) => boolean,
  value: (e: string, k: string) => string | null,
): string {
  if (has("agent_spawned")) return "agent";
  if (has("access_request") || has("access_decision")) return "access";
  if (
    has("connector_connected") ||
    has("connector_disconnected") ||
    has("connector_default_changed")
  ) return "access";
  if (
    events.some((e) => {
      const name = jv(e).get("event").str ?? "";
      return name.startsWith("browser_") || name.startsWith("credential_");
    })
  ) {
    return "browser";
  }
  const request = value("intent_received", "request") ?? "";
  if (has("tool_invoked") || request.startsWith("use ")) return "command";
  if (
    request.startsWith("read file") ||
    request.startsWith("write file") ||
    has("file_read") ||
    has("file_write")
  ) {
    return "file";
  }
  return "command";
}

function activityCommand(
  entry: (e: string) => JSONValue | null,
  value: (e: string, k: string) => string | null,
): string | null {
  const argv = jv(entry("exec_start") ?? null).get("argv").arr;
  if (argv && argv.length > 0) {
    return argv.filter((a): a is string => typeof a === "string").join(" ");
  }
  return value("intent_received", "request");
}

/**
 * What the page's own requests did, for the owner's timeline.
 *
 * The audit log carries the whole entry; this is the part a human scanning a
 * session needs — which host refused what, and how many. Empty when the page's
 * requests were answered, which is the ordinary case.
 */
function refusedSuffix(ev: ReturnType<typeof jv>): string {
  const refused = ev.get("failed_requests").arr ?? [];
  if (refused.length === 0) return "";
  const first = jv(refused[0]);
  const rest = refused.length > 1 ? ` (+${refused.length - 1} more)` : "";
  return ` — refused: ${first.get("status").int ?? 0} ${first.get("method").str ?? ""} ${first.get("origin").str ?? ""}${rest}`;
}

/** One-line human description of a single raw event (used in the timeline). */
function describeStep(e: JSONValue): AuditStep {
  const ev = jv(e);
  const event = ev.get("event").str ?? "";
  const argv = () => (ev.get("argv").arr ?? []).filter((a): a is string => typeof a === "string").join(" ");
  let text: string;
  let state: StepState = "neutral";
  switch (event) {
    case "device_started": text = "Device started"; break;
    case "access_request": text = `Access requested — ${ev.get("goals").str ?? ""}`; break;
    case "access_decision":
      text = ev.get("approved").bool ? "Access granted" : "Access denied";
      state = ev.get("approved").bool ? "ok" : "bad";
      break;
    case "agent_spawned": text = `Agent spawned — ${ev.get("goal").str ?? ""}`; break;
    case "connector_connected":
      text = `Google account connected — ${ev.get("account").str ?? ""}`; state = "ok"; break;
    case "connector_disconnected":
      text = `Google account disconnected — ${ev.get("account").str ?? ""}`; state = "ok"; break;
    case "connector_default_changed":
      text = `Default Google account changed — ${ev.get("account").str ?? ""}`; state = "ok"; break;
    case "activation_session_cleanup": {
      const outcome = ev.get("outcome").str ?? "";
      const keyId = ev.get("keyId").int;
      const suffix = keyId === null ? "" : ` — key ${keyId}`;
      if (outcome === "revoked") {
        text = `Activation session revoked${suffix}`;
        state = "ok";
      } else if (outcome === "failed") {
        text = `Activation session cleanup failed${suffix} — ${ev.get("error").str ?? "unknown error"}`;
        state = "bad";
      } else if (outcome === "ambiguous") {
        text = `Activation session cleanup skipped — ${ev.get("candidateCount").int ?? 0} matches`;
      } else if (outcome === "no_match") {
        text = "Activation session cleanup skipped — no matching session";
      } else if (outcome === "no_credential") {
        text = "Activation session cleanup skipped — this Mac is not signed in";
      } else {
        text = "Activation session cleanup skipped";
      }
      break;
    }
    case "intent_received": text = `Request: ${ev.get("request").str ?? ""}`; break;
    case "adversarial_review_started": text = "AI Reviewer started reviewing…"; break;
    case "adversarial_review_result": {
      const verdict = ev.get("verdict").str ?? "";
      const reason = ev.get("reason").str ?? "";
      const cause = ev.get("cause").str;
      // The event does not know which mode it was reviewed under, and an
      // abstention means different things in each: in Ask mode a human takes
      // it, in adversarial mode nobody does and the operation is denied. So
      // the wording describes only the reviewer's own act, which is the same
      // either way. ANY cause means no verdict came back, and defers to nobody.
      //
      // Only `no_credits` says the reviewer never ran, because only that one
      // knows: the account cannot pay for inference, so there was no call. The
      // rest is a bag of outages, refusals and unparseable answers that nothing
      // here can tell apart, and saying "could not run" of a reviewer that ran
      // and refused is a false account of the failure.
      const label =
        cause
          ? cause === "no_credits"
            ? "could not run"
            : "no usable verdict"
          : verdict === "allow"
            ? "allow"
            : verdict === "deny"
              ? "deny"
              : "would not decide";
      text = `AI Reviewer: ${label}${reason ? ` — ${reason}` : ""}`;
      state = verdict === "deny" || cause ? "bad" : verdict === "allow" ? "ok" : "neutral";
      break;
    }
    case "intent_decision":
      text = `Decision: ${ev.get("decision").str ?? ""} — ${decidedByLabel(ev.get("source").str) ?? "?"}`;
      state = ev.get("decision").str === "deny" ? "bad" : "ok";
      break;
    case "intent_rejected": text = `Rejected: ${ev.get("reason").str ?? ""}`; state = "bad"; break;
    case "approval_abandoned":
      text = "Never answered — the app closed while the approval was pending";
      break;
    case "exec_start": text = `Run started: ${argv()}`; break;
    case "exec_end":
      // The badge on this same run says it was killed; the line the owner
      // opens to find out why must not contradict it.
      text =
        ev.get("reaped").bool === true
          ? `Run killed — ${REAPED_REASON}`
          : `Run finished (exit ${ev.get("exit_code").int ?? -1})`;
      state = ev.get("exit_code").int === 0 ? "ok" : "bad";
      break;
    case "exec_error": text = `Run error: ${ev.get("error").str ?? ""}`; state = "bad"; break;
    case "file_read": text = `File read: ${ev.get("path").str ?? ""} (${ev.get("bytes").int ?? 0} bytes)`; state = "ok"; break;
    case "file_write": text = `File written: ${ev.get("path").str ?? ""} (${ev.get("bytes").int ?? 0} bytes)`; state = "ok"; break;
    case "denied_operation": {
      const bound = (ev.get("cause").str ?? "outside_approved_bound") === "outside_approved_bound";
      text = `${bound ? "Blocked" : "Failed"}: ${ev.get("path").str ?? ""} — ${ev.get("error").str ?? ""}`;
      state = "bad";
      break;
    }
    case "host_permission_blocked": {
      // The fixed owner sentence, verbatim — it is the one thing on this
      // line the owner can act on. `likely` says so, because a guess sent to
      // System Settings should read as a guess.
      const path = ev.get("path").str;
      const confidence = ev.get("confidence").str;
      const action = ev.get("owner_action").str;
      text =
        `This Mac refused${path ? ` ${path}` : ""}: ${hostGateLabel(ev)}` +
        `${confidence === "likely" ? " (probably)" : ""}` +
        `${action ? ` — ${action}` : ""}`;
      state = "bad";
      break;
    }
    case "tool_invoked": text = `Tool used: ${ev.get("tool").str ?? ""}`; state = "ok"; break;
    case "tool_error": text = `Tool error: ${ev.get("tool").str ?? ""} — ${ev.get("error").str ?? ""}`; state = "bad"; break;
    case "browser_session_opened":
      text = `Browser session opened — ${(ev.get("origins").arr ?? []).filter((o): o is string => typeof o === "string").join(", ")}`;
      state = "ok";
      break;
    case "browser_session_extended":
      text = `Session widened — origins: ${(ev.get("origins").arr ?? []).filter((o): o is string => typeof o === "string").join(", ") || "—"}; items: ${(ev.get("items").arr ?? []).filter((i): i is string => typeof i === "string").join(", ") || "—"}`;
      state = "ok";
      break;
    case "browser_cookie_merge_failed":
      text = `Sign-ins from this session could not be saved (${ev.get("error").str ?? "merge failed"}) — kept in ${ev.get("profile").str ?? "the session profile"}`;
      state = "bad";
      break;
    case "browser_session_closed": {
      const reason = ev.get("reason").str ?? "";
      const refused = refusedSuffix(ev);
      text = `Browser session closed (${reason})${refused}`;
      if (refused || reason === "crashed") state = "bad";
      break;
    }
    case "browser_command": {
      const refused = refusedSuffix(ev);
      text = `Browser: ${ev.get("action").str ?? ""}${ev.get("url").str ? ` — ${ev.get("url").str}` : ""}${ev.get("error").str ? ` — ${ev.get("error").str}` : ""}${refused}`;
      state = ev.get("error").str || refused ? "bad" : "neutral";
      break;
    }
    case "browser_navigated": text = `Page: ${ev.get("url").str ?? ""}`; break;
    case "browser_scope_violation":
      text = `Out of scope: ${ev.get("origin").str ?? ""} (${ev.get("action").str ?? ""}) — content locked`;
      state = "bad";
      break;
    case "credential_metadata":
      text = ev.get("op").str === "describe"
        ? `Credential fields listed: ${ev.get("item").str ?? ""} (labels only)`
        : "Credential list read (names only)";
      break;
    case "credential_filled":
      text = `Credential typed into page: ${ev.get("item").str ?? ""} · ${ev.get("field").str ?? ""} on ${ev.get("origin").str ?? ""}`;
      state = "ok";
      break;
    case "credential_fill_failed":
      // Not "not typed": the same event covers a field that TOOK the value and
      // is holding a changed copy of it, so the page is not untouched.
      text = `Credential fill failed: ${ev.get("item").str ?? ""} · ${ev.get("field").str ?? ""} into `
        + `${ev.get("selector").str ?? ""} on ${ev.get("origin").str ?? ""} — `
        + `${ev.get("reason").str ?? ""}`;
      state = "bad";
      break;
    case "credential_denied":
      text = `Credential refused: ${ev.get("item").str ?? ""} · ${ev.get("field").str ?? ""} — ${ev.get("reason").str ?? ""}`;
      state = "bad";
      break;
    case "credential_mask_failed":
      text = `Page not shown to the agent: a filled credential on ${ev.get("url").str ?? ""} `
        + `could not be kept hidden on screen, so ${ev.get("action").str ?? "the view"} was refused`;
      state = "bad";
      break;
    case "browser_crashed":
      text = `Browser crashed (code ${ev.get("code").int ?? -1})`;
      state = "bad";
      break;
    default: text = event;
  }
  return { time: clock(ev.get("ts").str ?? ""), text, state };
}

/**
 * Whether an activity matches a free-text search: title, command, agent,
 * goal, the permission a block named, and every timeline line — so what the
 * detail pane would show is what the box finds.
 */
export function activityMatches(a: AuditActivity, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    a.title,
    a.command ?? "",
    a.agentDisplay ?? "",
    a.agentId ?? "",
    a.goal ?? "",
    a.permission ?? "",
    ...a.timeline.map((s) => s.text),
  ]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

function dayTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function clock(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}
