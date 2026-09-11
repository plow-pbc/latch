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
// The audit view lives in device-core so the MCP server's `plow_history`
// shows an agent the same rows this window shows the owner.
export {
  auditActivities,
  decidedByLabel,
} from "@domo/device-core";
export type {
  AuditActivity,
  AuditStep,
  BadgeTone,
  DecisionKind,
  StatusKind,
  StepState,
} from "@domo/device-core";
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
   * Always Allow for them (the policy engine would refuse the rule anyway).
   * An AppleScript intent is the same mutation by another road, so it too. */
  sendsAppleEvents: boolean;
  /** applescript capability: the app it controls and the script, verbatim —
   * runs outside the sandbox, so the card shows the whole script. */
  scriptsApp: { app: string; bundleId: string; script: string } | null;
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
    // The chip names the target; the script itself gets its own block on the
    // card (scriptsApp) rather than being folded into a one-line chip.
    if (c.kind === "applescript") return `Script ${c.app ?? "?"} (${c.bundleId ?? "?"})`;
    return capabilityDisplay(c);
  };
  const scriptCap = caps.find((c) => c.kind === "applescript");
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
    sendsAppleEvents: caps.some((c) => (c.kind === "apple_events" && c.allowed === true) || c.kind === "applescript"),
    scriptsApp: scriptCap
      ? { app: scriptCap.app ?? "?", bundleId: scriptCap.bundleId ?? "?", script: scriptCap.script ?? "" }
      : null,
    origins: caps.find((c) => c.kind === "browser")?.origins ?? [],
    credentialItems,
  };
}

