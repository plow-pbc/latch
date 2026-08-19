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
    case "adversarial": return "AI Reviewer";
    case "rule": return "Always-allow rule";
    case "policy": return "Policy (deny mode)";
    // Not internal labels in the human's view: the operation was denied because
    // the reviewer could not run, not because anyone chose. One cannot be paid
    // for; the other was never configured.
    case "no_credits": return "AI Reviewer (out of credits)";
    case "no_reviewer": return "AI Reviewer (not configured)";
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
  const { status, tone, category } = classifyActivity(events, has, entry);
  return {
    id,
    time: dayTime(jv(events[0]).get("ts").str ?? ""),
    tone,
    status,
    title,
    kind: activityKind(events, has, value),
    category,
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
  if (has("agent_spawned")) return "Agent spawned";
  if (has("exec_end")) return "Command finished";
  return jv(events[0]).get("event").str ?? "Activity";
}

/**
 * Combined status of the whole operation (decision + outcome), color-coded,
 * plus the coarse filter bucket — one tree, so the badge and the chip cannot
 * drift apart. The buckets:
 *   - denied:   refused at the approval gate (a person, device, or deadline)
 *   - failed:   ran but didn't cleanly succeed — sandbox-blocked, errored,
 *               crashed, or a non-zero exit
 *   - approved: permitted and completed cleanly
 *   - other:    pending / spawned / live / uncategorized
 */
function classifyActivity(
  events: JSONValue[],
  has: (e: string) => boolean,
  entry: (e: string) => JSONValue | null,
): { status: string; tone: BadgeTone; category: string } {
  if (entry("intent_rejected")) return { status: "Rejected", tone: "red", category: "denied" };
  if (has("access_request") || has("access_decision")) {
    const d = entry("access_decision");
    if (d) {
      const ok = jv(d).get("approved").bool ?? false;
      return ok
        ? { status: "Granted", tone: "green", category: "approved" }
        : { status: "Denied", tone: "red", category: "denied" };
    }
    return { status: "Pending", tone: "zinc", category: "other" };
  }
  if (has("agent_spawned")) return { status: "Spawned", tone: "blue", category: "other" };
  // The decision outranks any browser events riding in the intent's group: a
  // browser_open/browser_request row says how it was decided, and the live
  // browsing state belongs to the session's own activity.
  const dec = entry("intent_decision");
  if (dec) {
    const decision = jv(dec).get("decision").str ?? "";
    if (decision === "deny") {
      // The deadline denying is a timeout, not a refusal (approvalStore.ts) —
      // the audit must not dress it up as one.
      if (jv(dec).get("source").str === "expired") {
        return { status: "Timed out", tone: "amber", category: "denied" };
      }
      return { status: "Denied", tone: "red", category: "denied" };
    }
    const base = decision === "always_allow" ? "Always allowed" : "Allowed once";
    // Failures/blocks keep their suffix; plain successes show just the base
    // (no "· done"/"· finished").
    if (entry("denied_operation")) {
      return { status: `${base} · blocked`, tone: "red", category: "failed" };
    }
    if (has("exec_error") || has("tool_error")) {
      return { status: `${base} · error`, tone: "red", category: "failed" };
    }
    const ee = entry("exec_end");
    if (ee) {
      const code = jv(ee).get("exit_code").int ?? -1;
      if (code !== 0) {
        return { status: `${base} · failed (exit ${code})`, tone: "amber", category: "failed" };
      }
    }
    return { status: base, tone: "green", category: "approved" };
  }
  if (events.some((e) => (jv(e).get("event").str ?? "").startsWith("browser_"))) {
    if (has("credential_fill_failed")) {
      return has("browser_session_closed")
        ? { status: "Closed · fill failed", tone: "amber", category: "failed" }
        : { status: "Fill failed", tone: "amber", category: "failed" };
    }
    if (has("credential_denied") || has("browser_scope_violation")) {
      // "failed", not "other": the cage refused the agent something, which is
      // the first thing an owner scanning for trouble filters for. The amber
      // badge already said so; the bucket disagreed, and the bucket is what
      // the filter reads.
      return has("browser_session_closed")
        ? { status: "Closed · scope blocks", tone: "amber", category: "failed" }
        : { status: "Scope blocked", tone: "amber", category: "failed" };
    }
    if (has("browser_session_closed")) {
      const closed = entry("browser_session_closed")!;
      return jv(closed).get("reason").str === "crashed"
        ? { status: "Crashed", tone: "red", category: "failed" }
        : { status: "Closed", tone: "zinc", category: "other" };
    }
    if (has("browser_crashed")) return { status: "Crashed", tone: "red", category: "failed" };
    return { status: "Browsing", tone: "green", category: "other" };
  }
  // A vault metadata read carries no intent and no session, so it stands
  // alone — and it is recorded only after the broker answered, so by the time
  // it is on disk the operation is already over. (The session-scoped twin of
  // this event is handled with its browser session above.)
  const vaultRead = entry("credential_metadata");
  if (vaultRead && jv(vaultRead).get("session").str === null) {
    return { status: "Completed", tone: "green", category: "approved" };
  }
  if (entry("denied_operation")) return { status: "Blocked", tone: "red", category: "failed" };
  // A handle-only exec_end from an old log: a deferred run's end recorded
  // without its intent. The exit code is the whole story.
  const ee = entry("exec_end");
  if (ee) {
    const code = jv(ee).get("exit_code").int ?? -1;
    return code === 0
      ? { status: "Finished", tone: "green", category: "approved" }
      : { status: `Failed (exit ${code})`, tone: "amber", category: "failed" };
  }
  if (has("approval_abandoned")) return { status: "Not answered", tone: "zinc", category: "other" };
  // Only an undecided intent is genuinely pending; anything else unrecognized
  // is a record, not an operation in flight.
  if (has("intent_received")) return { status: "Pending", tone: "zinc", category: "other" };
  return { status: "Info", tone: "zinc", category: "other" };
}

function activityKind(
  events: JSONValue[],
  has: (e: string) => boolean,
  value: (e: string, k: string) => string | null,
): string {
  if (has("agent_spawned")) return "agent";
  if (has("access_request") || has("access_decision")) return "access";
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
    case "adversarial_review_started": text = "AI Reviewer started reviewing…"; break;
    case "adversarial_review_result": {
      const verdict = ev.get("verdict").str ?? "";
      const reason = ev.get("reason").str ?? "";
      const cause = ev.get("cause").str;
      // "defer to you" is only true when the agent ran and chose not to decide.
      // A review that could not run at all defers to nobody — saying it did
      // would misdescribe who decided the operation that follows. ANY cause
      // means it could not run; that is what a cause is for.
      const label =
        cause
          ? "could not run"
          : verdict === "allow"
            ? "allow"
            : verdict === "deny"
              ? "deny"
              : "defer to you";
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
    case "credential_fill_failed":
      text = `Credential not typed: ${ev.get("item").str ?? ""} · ${ev.get("field").str ?? ""} into `
        + `${ev.get("selector").str ?? ""} on ${ev.get("origin").str ?? ""} — `
        + `${ev.get("reason").str ?? ""}`;
      state = "bad";
      break;
    case "credential_denied":
      text = `Credential refused: ${ev.get("item").str ?? ""} · ${ev.get("field").str ?? ""} — ${ev.get("reason").str ?? ""}`;
      state = "bad";
      break;
    case "browser_crashed": text = "Browser crashed"; state = "bad"; break;
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
