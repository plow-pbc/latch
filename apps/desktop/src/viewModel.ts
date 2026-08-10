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

export interface AuditRow {
  time: string;
  tone: BadgeTone;
  status: string;
  activity: string;
  /** "command" | "file" | "access" | "agent" | "info" — drives the row icon. */
  kind: string;
  raw: JSONValue;
}

/**
 * Fold the append-only audit event stream into human "activity" rows for the
 * master–detail table (mockup Alternative 1). This mirrors the mockup's
 * status vocabulary: Allowed/Always/Blocked/Denied/Granted/Spawned/Info.
 */
export function auditRows(events: JSONValue[]): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const e of events) {
    const ev = jv(e);
    const event = ev.get("event").str ?? "";
    const time = formatTime(ev.get("ts").str ?? "");
    switch (event) {
      case "intent_received": {
        rows.push({
          time,
          tone: "zinc",
          status: "Received",
          activity: ev.get("request").str ?? "intent",
          kind: activityKind(ev.get("request").str ?? ""),
          raw: e,
        });
        break;
      }
      case "intent_decision": {
        const decision = ev.get("decision").str ?? "";
        const source = ev.get("source").str ?? "";
        const tone: BadgeTone = decision === "deny" ? "red" : "green";
        const status =
          decision === "deny"
            ? "Denied"
            : decision === "always_allow"
              ? source === "rule"
                ? "Always · done"
                : "Always allow"
              : "Allowed · done";
        // Attach the decision to the most recent matching intent row if present.
        rows.push({ time, tone, status, activity: statusActivity(ev), kind: "command", raw: e });
        break;
      }
      case "intent_rejected": {
        rows.push({
          time,
          tone: "red",
          status: "Blocked",
          activity: `rejected: ${ev.get("reason").str ?? ""}`,
          kind: "command",
          raw: e,
        });
        break;
      }
      case "exec_end": {
        const code = ev.get("exit_code").int;
        rows.push({
          time,
          tone: code === 0 ? "green" : "red",
          status: code === 0 ? "Finished · exit 0" : `Exit ${code}`,
          activity: "run finished",
          kind: "command",
          raw: e,
        });
        break;
      }
      case "denied_operation": {
        rows.push({
          time,
          tone: "red",
          status: "Blocked",
          activity: ev.get("path").str ?? "operation blocked",
          kind: "file",
          raw: e,
        });
        break;
      }
      case "file_write":
        rows.push({ time, tone: "green", status: "Wrote", activity: `write: ${ev.get("path").str ?? ""}`, kind: "file", raw: e });
        break;
      case "file_read":
        rows.push({ time, tone: "green", status: "Read", activity: `read: ${ev.get("path").str ?? ""}`, kind: "file", raw: e });
        break;
      case "access_request":
        rows.push({
          time,
          tone: "blue",
          status: "Requested",
          activity: `Access — ${ev.get("display").str ?? ev.get("agent").str ?? "agent"}`,
          kind: "access",
          raw: e,
        });
        break;
      case "access_decision":
        rows.push({
          time,
          tone: ev.get("approved").bool ? "green" : "red",
          status: ev.get("approved").bool ? "Granted" : "Denied",
          activity: `Access — ${ev.get("agent").str ?? "agent"}`,
          kind: "access",
          raw: e,
        });
        break;
      case "agent_spawned":
        rows.push({ time, tone: "blue", status: "Spawned", activity: "Agent spawned", kind: "agent", raw: e });
        break;
      case "agent_revoked":
        rows.push({ time, tone: "amber", status: "Revoked", activity: `Agent ${ev.get("agent").str ?? ""}`, kind: "agent", raw: e });
        break;
      case "device_started":
        rows.push({ time, tone: "zinc", status: "Info", activity: "Device started", kind: "info", raw: e });
        break;
      case "pairing_requested":
        rows.push({ time, tone: "zinc", status: "Info", activity: "Pairing requested", kind: "info", raw: e });
        break;
      default:
        rows.push({ time, tone: "zinc", status: "Info", activity: event, kind: "info", raw: e });
    }
  }
  // Newest first for the table.
  return rows.reverse();
}

function statusActivity(ev: ReturnType<typeof jv>): string {
  return `decision: ${ev.get("decision").str ?? ""}`;
}

function activityKind(request: string): string {
  if (request.startsWith("run:")) return "command";
  if (request.startsWith("read file") || request.startsWith("write file")) return "file";
  if (request.startsWith("use blessed tool")) return "agent";
  return "command";
}

function formatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}
