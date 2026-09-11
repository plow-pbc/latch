/**
 * The privacy screen's four promises, in one place.
 *
 * They live here rather than in `onboarding.js` because the screenshot fixture
 * has to assert them and cannot import that module — it touches `document` and
 * `window.domo` at the top level, which neither the fixture's Node test nor the
 * offscreen harness has. So the copy was duplicated, and the duplicate went
 * stale the moment the copy was corrected: the fixture still demanded the
 * sentence promising owners they approve each action, which no longer ships,
 * and the screenshot run failed on text it could not find.
 *
 * Anything the fixture must assert verbatim belongs here. What it asserts is
 * generated from this, so the two cannot disagree again.
 */
export const TRUST_ROWS = [
  {
    title: "Data stays on your Mac",
    detail:
      "Your messages and calendar reach an agent only through an action this Mac approved. Your passwords never reach one at all: an agent can see which logins you have, and this Mac types them into the page itself.",
    glyph: "desktop",
  },
  {
    title: "You decide who decides",
    detail:
      "Out of the box the AI reviewer decides what an agent may do here — allowing it, or refusing it. Switch to deciding yourself whenever you want.",
    glyph: "sliders",
  },
  {
    title: "A second AI checks the risky stuff",
    detail: "An independent reviewer catches actions that don't look right.",
    glyph: "shieldCheck",
  },
  {
    title: "Never sold. Never trained on.",
    detail: "Your data isn't sold, stored, or used to train AI models.",
    glyph: "lock",
  },
];
