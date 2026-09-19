/* The Gatekeeper screen's presentation, as pure functions so vitest reaches
   them without a window. A row's reason is the reviewer's own sentence when it
   reached a verdict, and a fixed one when it did not — nothing a provider said
   about a failure is shown. */

export const NO_CREDITS_REASON =
  "Your Plow account is out of credits, so the gatekeeper can't review right now.";
export const UNAVAILABLE_REASON = "The gatekeeper didn't answer. Edit the text to try again.";

export function rowView(result) {
  if (!result) return { state: "checking", reason: "" };
  if (result.verdict === "allow") return { state: "ok", reason: result.reason };
  if (result.verdict === "deny") return { state: "no", reason: result.reason };
  return {
    state: "unavailable",
    reason: result.cause === "no_credits" ? NO_CREDITS_REASON : UNAVAILABLE_REASON,
  };
}

const VERDICT_WORDS = { ok: "Allowed", no: "Denied", unavailable: "Couldn't check", checking: "Analyzing…" };

/** The word after "Gatekeeper Verdict:" for a row in `state`. */
export function verdictWord(state) {
  return VERDICT_WORDS[state];
}

export function presetFor(text, presets) {
  return Object.keys(presets).find((key) => presets[key].text === text) ?? null;
}
