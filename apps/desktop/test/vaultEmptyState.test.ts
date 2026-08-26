/**
 * The Vault tab's status-to-copy decision, which had never been exercised by
 * anything: it lived inline in a renderer asset, so the only thing that could
 * reach it was an Electron run on another machine. That is how a build with no
 * runtime came to render as "the vault has not started yet" — the sentence
 * belonging to a different state entirely — and how a locked account did before
 * it.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error - a renderer asset, plain ESM with no types of its own.
import { vaultEmptyState } from "../src/renderer/vaultEmptyState.js";

/** Every headline this pane can produce, so each case can exclude the others. */
const HEADLINES = [
  "This build has no vault installed.",
  "This Mac can't unlock its vault account.",
  "The vault has not started yet.",
  "The vault reported a state this build does not know:",
];

describe("vaultEmptyState", () => {
  const cases: { why: string; reply: unknown; failure?: string; headline: string; note?: RegExp }[] = [
    {
      why: "no vault payload in this build",
      reply: { status: "missing" },
      headline: HEADLINES[0],
      // Claims nothing about the runtime around it, and offers no remedy: a
      // packaged install always bundles a vault, so its owner has a broken
      // install rather than a command to run.
      note: /^Nothing is lost — a build that includes the vault will open/,
    },
    {
      why: "the key has moved",
      reply: { status: "locked", reason: "undecryptable" },
      headline: HEADLINES[1],
      // Names the likely cause as likely, since one `catch` covers a wrong key
      // and a damaged file, and promises no recovery that does not exist.
      note: /Usually that means the key is no longer.*it can also mean the file itself is damaged/s,
    },
    {
      why: "this build has nowhere to keep the key",
      reply: { status: "locked", reason: "no-storage" },
      headline: HEADLINES[1],
      // A different fact from the one above and different words: nothing is
      // wrong with the account, this build just cannot open it.
      note: /no secure storage to open it with/,
    },
    {
      why: "the vault is still coming up",
      reply: { status: "starting" },
      headline: HEADLINES[2],
    },
    {
      // The arm that exists so a fifth status added in main.ts, or a packaged
      // renderer left behind by one, cannot silently inherit the sentence above.
      why: "the status is one this build does not know",
      reply: { status: "brandnew" },
      headline: "The vault reported a state this build does not know: brandnew",
    },
  ];

  it.each(cases)("says its own words and no others when $why", ({ reply, failure, headline, note }) => {
    const state = vaultEmptyState(reply, failure ?? "");

    expect(state.headline).toBe(headline);
    // The mutual exclusion, which is the whole history of this screen: twice a
    // state has been handed a sentence another state was already entitled to.
    for (const other of HEADLINES.filter((h) => !headline.startsWith(h))) {
      expect(state.headline).not.toContain(other);
    }
    if (note) expect(state.note).toMatch(note);
    else expect(state.note).toBeNull();
  });

  it.each([
    { why: "there is a list to show", reply: { status: "ready", items: [] }, failure: "" },
    // A failed call is not a status — nothing was read, so the pane reports the
    // failure rather than diagnosing a vault it never reached.
    { why: "the call failed", reply: null, failure: "the vault did not answer" },
    // A failure beats a status: the reply is stale or absent either way.
    { why: "the call failed despite a status", reply: { status: "missing" }, failure: "boom" },
  ])("renders no empty state when $why", ({ reply, failure }) => {
    expect(vaultEmptyState(reply, failure)).toBeNull();
  });
});
