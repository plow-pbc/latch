/**
 * Setup's "Meet the Plow Gatekeeper" step: the two instructions an owner can
 * start from, the five example requests each is shown against, and a live
 * review of one of them.
 *
 * A preview is not an operation. The request is built here from fixed data and
 * handed to the reviewer that decides real ones, with the owner's DRAFT as the
 * purpose — then only the verdict comes back. The renderer is shown each row's
 * capability lines, spelled as the reviewer reads them, but can't build or send
 * a request: it names only a preset, an index and the draft. Nothing is recorded: no audit
 * line, no telemetry, no rule, no approval queue, no policy engine. The example
 * paths sit under a fixed placeholder home, so no local account name leaves the
 * Mac.
 *
 * The verdicts come from a live model, so no test pins them. Any change to a
 * preset's text or to a row is re-rehearsed before merge — each preset against
 * its own deck, three runs, in the running app — and must read HOME ✓✓✓✕✕,
 * WORK ✓✓✓✓✕. Wording is load-bearing: "personal messages" once read as
 * including email and denied an inbox search.
 */
import { capabilityDisplay, makeIntent } from "@domo/protocol";
import { ReviewArgs, ReviewFailureCause, Verdict } from "./adversarialAgent.js";
import { gatekeeperExamples, Operation, PresetKey } from "./onboardingExamples.js";
import { Settings } from "./settings.js";

export type { PresetKey } from "./onboardingExamples.js";

/** Written TO the gatekeeper ABOUT the assistant — the gatekeeper is not the agent. */
export const PRESET_TEXT: Record<PresetKey, string> = {
  home:
    "Allow my family assistant to keep our calendar, text family, and order groceries online. " +
    "Never let it share my documents or passwords with anyone.",
  work:
    "Allow my work assistant to access my email, calendar and GitHub. " +
    "Keep it out of my personal texts and chats.",
};

export interface PresetView {
  text: string;
  rows: { label: string; icon: string; command: string[] }[];
}

export interface PreviewResult {
  verdict: Verdict;
  reason: string;
  cause?: ReviewFailureCause;
}

export interface PreviewDeps {
  review: (args: ReviewArgs) => Promise<PreviewResult>;
  settings: Settings;
  apiBaseUrl: string;
}

/**
 * What the screen draws: the preset text and each row's label, icon and
 * capability lines — `capabilityDisplay`, the reviewer's own bounds lines, so
 * what's shown is exactly what's reviewed.
 */
export function gatekeeperPresets(): Record<PresetKey, PresetView> {
  const view = (key: PresetKey): PresetView => ({
    text: PRESET_TEXT[key],
    rows: gatekeeperExamples(key).map(({ label, icon, operation }) => ({
      label,
      icon,
      command: operation.capabilities.map(capabilityDisplay),
    })),
  });
  return { home: view("home"), work: view("work") };
}

/**
 * Review one example row against the owner's draft. `preset`, `index` and
 * `draft` come from the sandboxed renderer, so each is checked here.
 */
export async function previewRow(
  preset: unknown,
  index: unknown,
  draft: unknown,
  deps: PreviewDeps,
): Promise<PreviewResult> {
  const deck = preset === "home" || preset === "work" ? gatekeeperExamples(preset) : undefined;
  const row = deck && typeof index === "number" && Number.isInteger(index) ? deck[index] : undefined;
  if (!row) throw new Error("no such preview row");
  return reviewOperation(row.operation, typeof draft === "string" ? draft : "", deps);
}

export async function reviewOperation(
  operation: Operation,
  agentPurpose: string,
  deps: PreviewDeps,
): Promise<PreviewResult> {
  const { request, capabilities } = operation;
  const intent = makeIntent({
    agentId: "preview",
    agentDisplay: "Your assistant",
    deviceId: "preview",
    request,
    capabilities,
    sessionId: "preview",
  });
  return deps.review({
    intent,
    history: [],
    // A SECRET: it reaches the reviewer's Authorization header and nothing else.
    plowCredential: (deps.settings.relayCredential ?? "").trim(),
    agentPurpose,
    apiBaseUrl: deps.apiBaseUrl,
    // The default mode: the reviewer decides, and nobody is asked.
    humanAvailable: false,
  });
}
