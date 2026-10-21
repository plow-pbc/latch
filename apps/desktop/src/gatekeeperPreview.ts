/**
 * Setup's "Meet the Plow Gatekeeper" step: the two instructions an owner can
 * start from, the five example requests each is shown against, and a live
 * review of them.
 *
 * The step comes before sign-in, so the review is not the reviewer that decides
 * real operations — that one runs on the owner's account. It is Plow's public
 * Gatekeeper demo route, the one the web demo uses: the owner's DRAFT goes up
 * with each row's capability lines, spelled as the real reviewer reads them,
 * and one ALLOWED or DENIED per row comes back with a fixed reason. No
 * credential goes with it. The renderer is shown the same lines but can't build
 * or send a request: it names only a preset and the draft. Nothing is recorded:
 * no audit line, no telemetry, no rule, no approval queue, no policy engine.
 * The example paths sit under a fixed placeholder home, so no local account
 * name leaves the Mac.
 *
 * The verdicts come from a live model, so no test pins them. Any change to a
 * preset's text or to a row is re-rehearsed before merge — each preset against
 * its own deck, three runs — and must read HOME ✓✓✓✕✕, WORK ✓✓✓✓✕. Wording is
 * load-bearing: "personal messages" once read as including email and denied an
 * inbox search, and adding the rows' labels to what is sent denied the
 * Instacart sign-in.
 */
import { capabilityDisplay } from "@domo/protocol";
import { Verdict } from "./adversarialAgent.js";
import { GATEKEEPER_DECKS, Operation, PresetKey } from "./onboardingExamples.js";
import { PlowApi } from "./plowApi.js";

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

/** A row's review: `allow` or `deny` with the demo's reason, or `ask` when it
 * could not be checked. */
export interface PreviewResult {
  verdict: Verdict;
  reason: string;
}

/** A row's capability lines — `capabilityDisplay`, the reviewer's own bounds
 * lines — which are both what the screen shows and what is reviewed. */
function command(operation: Operation): string[] {
  return operation.capabilities.map(capabilityDisplay);
}

/** What the screen draws: the preset text and each row's label, icon and capability lines. */
export function gatekeeperPresets(): Record<PresetKey, PresetView> {
  const view = (key: PresetKey): PresetView => ({
    text: PRESET_TEXT[key],
    rows: GATEKEEPER_DECKS[key].map(({ label, icon, operation }) => ({
      label,
      icon,
      command: command(operation),
    })),
  });
  return { home: view("home"), work: view("work") };
}

/**
 * Review every row of one preset's deck against the owner's draft, in one
 * call. `preset` and `draft` come from the sandboxed renderer, so each is
 * checked here. A demo that did not answer, or answered in any shape but one
 * verdict per row, leaves every row unchecked — never a guessed verdict.
 */
export async function previewDeck(
  preset: unknown,
  draft: unknown,
  api: Pick<PlowApi, "gatekeeperDemo">,
): Promise<PreviewResult[]> {
  const deck = preset === "home" || preset === "work" ? GATEKEEPER_DECKS[preset] : undefined;
  if (!deck) throw new Error("no such preview deck");
  const unchecked = deck.map((): PreviewResult => ({ verdict: "ask", reason: "" }));
  let answer: unknown;
  try {
    answer = await api.gatekeeperDemo(
      typeof draft === "string" ? draft : "",
      deck.map(({ operation }) => ({ capabilities: command(operation) })),
    );
  } catch {
    return unchecked;
  }
  const results = (answer as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== deck.length) return unchecked;
  const read = results.map((result): PreviewResult | null => {
    const { verdict, reason } = (result ?? {}) as { verdict?: unknown; reason?: unknown };
    const mapped = verdict === "ALLOWED" ? "allow" : verdict === "DENIED" ? "deny" : null;
    return mapped && typeof reason === "string" ? { verdict: mapped, reason } : null;
  });
  return read.every((result) => result !== null) ? (read as PreviewResult[]) : unchecked;
}
