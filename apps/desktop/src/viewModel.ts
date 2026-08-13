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
  usesBrowser: boolean;
  fillsCredentials: boolean;
  /** browser capability origins, for the card. */
  origins: string[];
  /** credential(fill) items with titles resolved ON-DEVICE (never from the
   * intent — agent-supplied titles would be spoofable). Title null = the
   * local vault could not resolve the id: a deny signal for humans. */
  credentialItems: { id: string; title: string | null; category: string | null }[];
}

/** Locally-resolved 1Password item titles, keyed by item id. */
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
      return `Credentials: fill ${names.join(", ")} into approved sites (values never leave this Mac)`;
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
  let apwActivity: string | null = null; // current Apple Passwords lifecycle
  let apwStarted = false; // that lifecycle has seen its "starting" already
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
    const session = ev.get("session").str;
    if (intentId !== null) {
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
    } else if (
      event === "apw_state" ||
      event === "apw_warmup" ||
      event === "credential_source_changed"
    ) {
      // One activity per Apple Passwords daemon lifecycle (enable/launch →
      // pairing → warm-up → stop). These events carry no intent/session; left
      // ungrouped each rendered as its own row stuck on "Pending" forever.
      const state = ev.get("state").str;
      const isStart = event === "apw_state" && state === "starting";
      if (apwActivity === null || (isStart && apwStarted)) {
        counter += 1;
        apwActivity = `apw:${counter}`;
        apwStarted = false;
      }
      if (isStart) apwStarted = true;
      push(apwActivity, e);
      if (event === "apw_state" && state === "stopped") {
        apwActivity = null;
        apwStarted = false;
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
    category: activityCategory(events, has, entry),
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
  if (events.some((e) => (jv(e).get("event").str ?? "").startsWith("apw_"))) {
    return "Apple Passwords";
  }
  const source = value("credential_source_changed", "source");
  if (source !== null) {
    return `Credential source — ${source === "1password" ? "1Password" : "Apple Passwords"}`;
  }
  if (events.some((e) => (jv(e).get("event").str ?? "").startsWith("browser_"))) {
    const lastNav = [...events]
      .reverse()
      .find((e) => jv(e).get("event").str === "browser_navigated");
    const url = lastNav ? (jv(lastNav).get("url").str ?? "") : "";
    return url ? `Browsing — ${url}` : "Browser session";
  }
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
  if (has("apw_state") || has("apw_warmup") || has("credential_source_changed")) {
    // These are punctual lifecycle facts, never "pending" — the latest state
    // event IS the outcome.
    const lastState = [...events].reverse().find((e) => jv(e).get("event").str === "apw_state");
    const state = lastState ? (jv(lastState).get("state").str ?? "") : "";
    const warm = entry("apw_warmup");
    const warmedOk = warm !== null && jv(warm).get("ok").bool === true;
    if (state === "error") return { status: "Failed", tone: "red" };
    if (state === "stopped") return { status: "Ended", tone: "zinc" };
    if (state === "paired") {
      return warmedOk
        ? { status: "Paired · AutoFill approved", tone: "green" }
        : { status: "Paired", tone: "green" };
    }
    if (state === "awaiting-pin") return { status: "Awaiting PIN", tone: "amber" };
    if (state === "starting") return { status: "Starting", tone: "blue" };
    return { status: "Info", tone: "zinc" };
  }
  if (events.some((e) => (jv(e).get("event").str ?? "").startsWith("browser_"))) {
    if (has("credential_denied") || has("browser_scope_violation")) {
      return has("browser_session_closed")
        ? { status: "Closed · scope blocks", tone: "amber" }
        : { status: "Scope blocked", tone: "amber" };
    }
    if (has("browser_session_closed")) return { status: "Closed", tone: "zinc" };
    if (has("browser_crashed")) return { status: "Crashed", tone: "red" };
    return { status: "Browsing", tone: "green" };
  }
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
  if (has("apw_state") || has("apw_warmup") || has("credential_source_changed")) return "access";
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

/**
 * Coarse filter bucket, derived from the events (not the status string):
 *   - denied:   refused at the approval gate (a person/device said no)
 *   - failed:   ran but didn't cleanly succeed — sandbox-blocked, errored, or a
 *               non-zero exit (this absorbs the old "blocked" bucket)
 *   - approved: permitted and completed cleanly
 *   - other:    pending / spawned / uncategorized
 */
function activityCategory(
  events: JSONValue[],
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
  if (has("apw_state")) {
    // An error anywhere in the Apple Passwords lifecycle files it under the
    // "failed" chip; otherwise it's housekeeping.
    const errored = events.some(
      (e) => jv(e).get("event").str === "apw_state" && jv(e).get("state").str === "error",
    );
    return errored ? "failed" : "other";
  }
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
    case "browser_session_opened":
      text = `Browser session opened — ${(ev.get("origins").arr ?? []).filter((o): o is string => typeof o === "string").join(", ")}`;
      state = "ok";
      break;
    case "browser_session_extended":
      text = `Session widened — origins: ${(ev.get("origins").arr ?? []).filter((o): o is string => typeof o === "string").join(", ") || "—"}; items: ${(ev.get("items").arr ?? []).filter((i): i is string => typeof i === "string").join(", ") || "—"}`;
      state = "ok";
      break;
    case "browser_session_closed": text = `Browser session closed (${ev.get("reason").str ?? ""})`; break;
    case "browser_command":
      text = `Browser: ${ev.get("action").str ?? ""}${ev.get("url").str ? ` — ${ev.get("url").str}` : ""}${ev.get("error").str ? ` — ${ev.get("error").str}` : ""}`;
      state = ev.get("error").str ? "bad" : "neutral";
      break;
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
    case "credential_denied":
      text = `Credential refused: ${ev.get("item").str ?? ""} · ${ev.get("field").str ?? ""} — ${ev.get("reason").str ?? ""}`;
      state = "bad";
      break;
    case "browser_started": text = "Browser launched"; break;
    case "browser_stopped": text = "Browser stopped"; break;
    case "browser_crashed": text = "Browser crashed"; state = "bad"; break;
    case "apw_state": {
      const s = ev.get("state").str ?? "";
      const detail = ev.get("detail").str ?? "";
      const labels: { [k: string]: string } = {
        starting: "Apple Passwords helper starting…",
        "awaiting-pin": "Waiting for the macOS pairing PIN",
        paired: "Paired with Apple Passwords",
        stopped: "Apple Passwords helper stopped",
        error: `Apple Passwords failed: ${detail}`,
      };
      text = labels[s] ?? `Apple Passwords: ${s}`;
      state = s === "paired" ? "ok" : s === "error" ? "bad" : "neutral";
      break;
    }
    case "apw_warmup":
      if (ev.get("skipped").bool) {
        text = "AutoFill warm-up skipped — no saved entry to release yet";
      } else if (ev.get("ok").bool) {
        text = `AutoFill approval requested (${ev.get("host").str ?? ""})`;
        state = "ok";
      } else {
        text = `AutoFill warm-up failed (${ev.get("host").str ?? ""})`;
        state = "bad";
      }
      break;
    case "credential_source_changed":
      text = `Credential source: ${ev.get("source").str === "1password" ? "1Password" : "Apple Passwords"}`;
      break;
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
