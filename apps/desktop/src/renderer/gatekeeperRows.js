/* The Gatekeeper screen's presentation, as pure functions so vitest reaches
   them without a window. A row's reason is the demo's fixed reason for its
   verdict, and a fixed one when it could not be checked. */

export const UNAVAILABLE_REASON = "The gatekeeper didn't answer. Edit the text to try again.";

export function rowView(result) {
  if (!result) return { state: "checking", reason: "" };
  if (result.verdict === "allow") return { state: "ok", reason: result.reason };
  if (result.verdict === "deny") return { state: "no", reason: result.reason };
  return { state: "unavailable", reason: UNAVAILABLE_REASON };
}

const VERDICT_WORDS = { ok: "Allowed", no: "Denied", unavailable: "Couldn't check", checking: "Analyzing…" };

/** The word after "Gatekeeper Verdict:" for a row in `state`. */
export function verdictWord(state) {
  return VERDICT_WORDS[state];
}

export function presetFor(text, presets) {
  return Object.keys(presets).find((key) => presets[key].text === text) ?? null;
}
