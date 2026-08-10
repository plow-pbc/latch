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
}

/** Build the approval card model from an already-verified intent. */
export function approvalViewModel(intent: Intent): ApprovalViewModel {
  const caps: Capability[] = intent.capabilities ?? [];
  return {
    intentId: intent.intentId,
    agentDisplay: intent.agentDisplay,
    agentId: intent.agentId,
    goal: intent.goal ?? "",
    request: intent.request,
    planContext: intent.planContext ?? null,
    capabilities: caps.map((c) => ({ kind: c.kind, display: capabilityDisplay(c) })),
    needsNetwork: caps.some((c) => c.kind === "network" && c.allowed === true),
    writesFiles: caps.some((c) => c.kind === "fs.write"),
    runsCommand: caps.some((c) => c.kind === "process.exec"),
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
export interface AuditActivity {
  id: string;
  time: string;
  tone: BadgeTone;
  status: string;
  title: string;
  /** "command" | "file" | "access" | "agent" | "info" — drives the row icon. */
  kind: string;
  /** Coarse filter bucket: "approved" | "denied" | "blocked" | "other". */
  category: string;
  command: string | null;
  agentId: string | null;
  agentDisplay: string | null;
  goal: string | null;
  intentId: string | null;
  exitCode: number | null;
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
    case "adversarial": return "Adversarial Agent";
    case "rule": return "Always-allow rule";
    case "policy": return "Policy (deny mode)";
    case "ask":
    case "prompt": return "You (asked)";
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
    // "Device started" is noise — never surface it as an activity.
    if (event === "device_started") continue;
    const intentId = ev.get("intentId").str;
    if (intentId !== null) {
      push(`intent:${intentId}`, e);
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
  const { status, tone } = activityStatus(events, has, entry);
  return {
    id,
    time: dayTime(jv(events[0]).get("ts").str ?? ""),
    tone,
    status,
    title,
    kind: activityKind(events, has, value),
    category: activityCategory(has, entry),
    command: activityCommand(entry, value),
    agentId:
      value("intent_received", "agent") ??
      value("access_request", "agent") ??
      value("access_decision", "agent") ??
      value("agent_spawned", "agent"),
    agentDisplay: value("access_request", "display"),
    goal:
      value("intent_received", "goal") ??
      value("access_request", "goals") ??
      value("agent_spawned", "goal"),
    intentId: jv(events[0]).get("intentId").str,
    exitCode: entry("exec_end") ? jv(entry("exec_end")!).get("exit_code").int : null,
    capabilities: (jv(entry("intent_received") ?? null).get("capabilities").arr ?? []).filter(
      (c): c is string => typeof c === "string",
    ),
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
  if (request !== null) return request;
  if (has("access_request") || has("access_decision")) {
    return `Access — ${value("access_request", "display") ?? "agent"}`;
  }
  if (has("agent_spawned")) return "Agent spawned";
  if (has("device_started")) return "Device started";
  return jv(events[0]).get("event").str ?? "Activity";
}

/** Combined status of the whole operation (decision + outcome), color-coded. */
function activityStatus(
  events: JSONValue[],
  has: (e: string) => boolean,
  entry: (e: string) => JSONValue | null,
): { status: string; tone: BadgeTone } {
  if (entry("intent_rejected")) return { status: "Rejected", tone: "red" };
  if (has("access_request") || has("access_decision")) {
    const d = entry("access_decision");
    if (d) {
      const ok = jv(d).get("approved").bool ?? false;
      return ok ? { status: "Granted", tone: "green" } : { status: "Denied", tone: "red" };
    }
    return { status: "Pending", tone: "zinc" };
  }
  if (has("device_started")) return { status: "Info", tone: "zinc" };
  if (has("agent_spawned")) return { status: "Spawned", tone: "blue" };
  const dec = entry("intent_decision");
  if (dec) {
    const decision = jv(dec).get("decision").str ?? "";
    if (decision === "deny") return { status: "Denied", tone: "red" };
    const base = decision === "always_allow" ? "Always allowed" : "Allowed once";
    // Failures/blocks keep their suffix; plain successes show just the base
    // (no "· done"/"· finished").
    if (entry("denied_operation")) return { status: `${base} · blocked`, tone: "red" };
    if (has("exec_error") || has("tool_error")) return { status: `${base} · error`, tone: "red" };
    const ee = entry("exec_end");
    if (ee) {
      const code = jv(ee).get("exit_code").int ?? -1;
      if (code !== 0) return { status: `${base} · failed (exit ${code})`, tone: "amber" };
    }
    return { status: base, tone: "green" };
  }
  if (entry("denied_operation")) return { status: "Blocked", tone: "red" };
  return { status: "Pending", tone: "zinc" };
}

function activityKind(
  events: JSONValue[],
  has: (e: string) => boolean,
  value: (e: string, k: string) => string | null,
): string {
  if (has("device_started")) return "info";
  if (has("agent_spawned")) return "agent";
  if (has("access_request") || has("access_decision")) return "access";
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

/**
 * Coarse filter bucket, derived from the events (not the status string):
 *   - denied:   refused at the approval gate (a person/device said no)
 *   - failed:   ran but didn't cleanly succeed — sandbox-blocked, errored, or a
 *               non-zero exit (this absorbs the old "blocked" bucket)
 *   - approved: permitted and completed cleanly
 *   - other:    pending / spawned / uncategorized
 */
function activityCategory(
  has: (e: string) => boolean,
  entry: (e: string) => JSONValue | null,
): string {
  if (entry("intent_rejected")) return "denied";
  if (has("access_request") || has("access_decision")) {
    const d = entry("access_decision");
    if (d) return jv(d).get("approved").bool ? "approved" : "denied";
    return "other"; // pending
  }
  const dec = entry("intent_decision");
  if (dec) {
    if (jv(dec).get("decision").str === "deny") return "denied";
    if (entry("denied_operation")) return "failed"; // sandbox/scope block
    if (has("exec_error") || has("tool_error")) return "failed";
    const ee = entry("exec_end");
    if (ee && (jv(ee).get("exit_code").int ?? 0) !== 0) return "failed";
    return "approved";
  }
  if (entry("denied_operation")) return "failed";
  return "other";
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
    case "intent_received": text = `Request: ${ev.get("request").str ?? ""}`; break;
    case "adversarial_review_started": text = "Adversarial agent started reviewing…"; break;
    case "adversarial_review_result": {
      const verdict = ev.get("verdict").str ?? "";
      const reason = ev.get("reason").str ?? "";
      const label = verdict === "allow" ? "allow" : verdict === "deny" ? "deny" : "defer to you";
      text = `Adversarial agent: ${label}${reason ? ` — ${reason}` : ""}`;
      state = verdict === "deny" ? "bad" : verdict === "allow" ? "ok" : "neutral";
      break;
    }
    case "intent_decision":
      text = `Decision: ${ev.get("decision").str ?? ""} — ${decidedByLabel(ev.get("source").str) ?? "?"}`;
      state = ev.get("decision").str === "deny" ? "bad" : "ok";
      break;
    case "intent_rejected": text = `Rejected: ${ev.get("reason").str ?? ""}`; state = "bad"; break;
    case "exec_start": text = `Run started: ${argv()}`; break;
    case "exec_end":
      text = `Run finished (exit ${ev.get("exit_code").int ?? -1})`;
      state = ev.get("exit_code").int === 0 ? "ok" : "bad";
      break;
    case "exec_error": text = `Run error: ${ev.get("error").str ?? ""}`; state = "bad"; break;
    case "file_read": text = `File read: ${ev.get("path").str ?? ""} (${ev.get("bytes").int ?? 0} bytes)`; state = "ok"; break;
    case "file_write": text = `File written: ${ev.get("path").str ?? ""} (${ev.get("bytes").int ?? 0} bytes)`; state = "ok"; break;
    case "denied_operation": text = `Blocked: ${ev.get("path").str ?? ""} — ${ev.get("error").str ?? ""}`; state = "bad"; break;
    case "tool_invoked": text = `Tool used: ${ev.get("tool").str ?? ""}`; state = "ok"; break;
    case "tool_error": text = `Tool error: ${ev.get("tool").str ?? ""} — ${ev.get("error").str ?? ""}`; state = "bad"; break;
    default: text = event;
  }
  return { time: clock(ev.get("ts").str ?? ""), text, state };
}

/** Whether an activity matches a free-text search (title/command/agent/goal). */
export function activityMatches(a: AuditActivity, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [a.title, a.command ?? "", a.agentDisplay ?? "", a.agentId ?? "", a.goal ?? ""]
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
