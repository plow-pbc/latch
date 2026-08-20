/**
 * What the real Python listener keeps, and who it hands it to — driven through
 * a probe, so it is skipped where there is no python3. The enforcement layer's
 * half (re-strip, host-only projection, approved origins, the audit) is in
 * browserSessions.test.ts against the fake server.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { havePython, runProbe } from "./pythonProbe.js";

const PROBE = fileURLToPath(new URL("../../../e2e/fixtures/failedRequestProbe.py", import.meta.url));

interface Envelope {
  failed_requests?: { status: number; method: string; origin: string; initiator: string }[];
}

describe.skipIf(!havePython())("the real response listener in server.py", () => {
  const probed = runProbe<{
    listens: string[];
    refused: Envelope;
    navigations: Envelope;
    frame_moved_first: Envelope;
    blind_navigation: Envelope;
    unremembered: Envelope;
    forgets_the_answered: number;
    unattributable: Envelope;
    drained: Envelope;
    quiet: Envelope;
    bounded: Envelope;
    hostile: Envelope;
  }>(PROBE);

  it("listens on the context, so a popup's refusals count too", () => {
    expect(probed.listens).toEqual(["request", "response"]);
  });

  it("keeps the origin that refused and nothing a site could put a token in", () => {
    // Not the path either: /reset/<token> is a url sites really send.
    expect(probed.refused.failed_requests).toEqual([
      {
        status: 429,
        method: "POST",
        origin: "https://signin.example",
        initiator: "https://pizza.example",
        retry_after: "30",
        server: "cloudfront",
      },
    ]);
  });

  it("drops a top-level navigation, keeps a frame's document load", () => {
    // An agent that goes somewhere and is refused SEES that on its next
    // screenshot. A payment or sign-in iframe that will not load is invisible
    // in exactly the way this exists for, and is named by whoever embedded it —
    // the frame itself is still blank when it asks.
    expect((probed.navigations.failed_requests ?? []).map((r) => [r.status, r.initiator]))
      .toEqual([
        [404, "https://offsite.example"], // an ordinary subresource
        [408, "https://pizza.example"], // a same-origin frame reloading itself
        // A loaded child could have moved itself or been moved by its embedder,
        // and nothing here can say which — so unless the two agree it names
        // nobody, in both directions of the borrow.
        [409, ""], // approved child, out-of-scope embedder
        [410, ""], // out-of-scope child, approved embedder
        [403, "https://pizza.example"], // a blank frame: its embedder asked
      ]);
  });

  it("forgets a request the moment it comes back fine", () => {
    // Otherwise completed traffic crowds a still-pending refusal out of the
    // ledger, and the refusal arrives naming nobody.
    expect(probed.forgets_the_answered).toBe(0);
  });

  it("reads who asked when the request was MADE, not when it was answered", () => {
    // Otherwise a page asks for something it knows will fail, moves itself to
    // an approved origin, and the refusal reads as that origin's own trouble.
    expect(probed.frame_moved_first.failed_requests?.[0]).toMatchObject({
      origin: "https://pizza.example",
      initiator: "https://offsite.example",
    });
  });

  it("keeps a navigation whose frame will not answer rather than losing it", () => {
    // The decision is made on the request, where an unanswerable frame already
    // means "names nobody" — a second read on the answer path would have cost
    // the whole entry instead.
    expect(probed.blind_navigation.failed_requests?.[0]).toMatchObject({
      status: 403,
      initiator: "",
    });
  });

  it("names nobody for a request it never saw asked", () => {
    expect(probed.unremembered.failed_requests?.[0]).toMatchObject({ initiator: "" });
  });

  it("names nobody when the frame will not answer, or answers with nothing", () => {
    // A service worker's request raises on `frame`; an about:blank child frame
    // answers with a url that names no origin; a blob: frame answers with one
    // that only looks like it does. All three are what a locked-out page would
    // reach for, so all three name nobody and the device withholds them from
    // the agent while the owner still sees them.
    expect((probed.unattributable.failed_requests ?? []).map((r) => [r.status, r.initiator]))
      .toEqual([[410, ""], [429, ""], [403, ""]]);
  });

  it("hands each refusal over once, so the next reply is not told again", () => {
    expect(probed.drained.failed_requests).toBeUndefined();
  });

  it("keeps nothing for a page that worked, redirects included", () => {
    expect(probed.quiet.failed_requests).toBeUndefined();
  });

  it("keeps the most recent few, most recent first", () => {
    // Nine distinguishable refusals: the five newest survive, newest first.
    expect((probed.bounded.failed_requests ?? []).map((r) => r.status))
      .toEqual([408, 407, 406, 405, 404]);
  });

  it("drops a response that will not answer, and keeps the next one", () => {
    // On the page's event thread the only safe answer to a question that raises
    // is to leave the ring alone — a decision, so it is asserted.
    expect((probed.hostile.failed_requests ?? []).map((r) => r.status)).toEqual([401]);
  });

});
