/**
 * A page's own requests failing, made visible.
 *
 * What the real Python listener keeps, and who it hands it to — driven through
 * a probe, so it is skipped where there is no python3. The enforcement layer's
 * half of this (re-strip, bound, audit, withhold off-scope) is in
 * browserSessions.test.ts, against the fake server.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { havePython, runProbe } from "./pythonProbe.js";

const PROBE = fileURLToPath(new URL("../../../e2e/fixtures/failedRequestProbe.py", import.meta.url));

interface FailedRequest {
  status: number;
  method: string;
  url: string;
  frame_url: string;
  bytes?: number;
  retry_after?: string;
  server?: string;
}
interface Envelope {
  failed_requests?: FailedRequest[];
}

describe.skipIf(!havePython())("the real response listener in server.py", () => {
  const probed = runProbe<{
    listens: string[];
    refused: Envelope;
    drained: Envelope;
    navigation: Envelope;
    subframe_navigation: Envelope;
    background_navigation: Envelope;
    redirected_navigation: Envelope;
    self_navigation: Envelope;
    after_use_page: Envelope;
    page_left_behind: Envelope;
    over_the_hop_limit: Envelope;
    long_chain: Envelope;
    after_the_goto_returned: Envelope;
    navigation_asked_for: string;
    during_the_settle: Envelope;
    unattributable: Envelope;
    unattributable_navigation: Envelope;
    quiet: Envelope;
    bounded: Envelope;
    hostile: Envelope;
  }>(PROBE);

  it("listens on the context, so a popup's refusals count too", () => {
    expect(probed.listens).toEqual(["response"]);
  });

  it("reports a refused request without its query string", () => {
    expect(probed.refused.failed_requests).toEqual([
      {
        status: 429,
        method: "POST",
        url: "https://signin.example/tenant/SelfAsserted",
        // Which document asked — the device needs both ends approved.
        frame_url: "https://pizza.example/checkout",
        bytes: 1180,
        retry_after: "30",
        server: "cloudfront",
      },
    ]);
  });

  it("hands each refusal over once, so the next action is not told again", () => {
    expect(probed.drained.failed_requests).toBeUndefined();
  });


  // Who a refusal is attributed to, one row per way a navigation can happen.
  // The rule under all of them: a page must never get to write the agent's
  // evidence by choosing a url, so only the goto this session issued — on the
  // page it is driving, through however many redirects — names itself.
  const ATTRIBUTION: [name: string, key: keyof typeof probed, url: string, frameUrl: string][] = [
    ["the goto the agent asked for names itself, not the page being left",
      "navigation", "https://pizza.example/checkout", "https://pizza.example/checkout"],
    ["a redirect chain is walked back to what the agent asked for",
      "redirected_navigation", "https://signin.pizza.example/b2c", "https://signin.pizza.example/b2c"],
    ["a sign-in-length chain — the browser's full 20 redirects — still is",
      "long_chain", "https://signin.pizza.example/b2c/end", "https://signin.pizza.example/b2c/end"],
    ["one redirect further gives up, and gives up on the safe side",
      "over_the_hop_limit", "https://pizza.example/end", "https://pizza.example/cart"],
    ["a page navigating ITSELF is named by the document it is showing",
      "self_navigation", "https://pizza.example/anything-it-likes", "https://offsite.example/lander"],
    ["a subframe's navigation belongs to whoever embedded it",
      "subframe_navigation", "https://pizza.example/anything-it-likes", "https://offsite.example/lander"],
    ["a background popup's is named by what it is showing, not where it was pointed",
      "background_navigation", "https://pizza.example/anything-it-likes", "https://offsite.example/lander"],
    ["the settle second after a goto is outside the window",
      "during_the_settle", "https://pizza.example/checkout", "https://offsite.example/lander"],
    ["nothing survives the goto for back, use_page or a scripted location to claim",
      "after_the_goto_returned", "https://pizza.example/pay", "https://pizza.example/cart"],
  ];

  it.each(ATTRIBUTION)("%s", (_name, key, url, frame_url) => {
    expect((probed[key] as Envelope).failed_requests?.[0]).toMatchObject({ url, frame_url });
  });

  it("records what the goto asked for, stripped, on the way in", () => {
    // The plumbing, not just the predicate: the real command handler ran.
    expect(probed.navigation_asked_for).toBe("https://pizza.example/checkout?tx=SECRET");
  });

  it("follows use_page: the agent drives the page it switched to, not the one it left", () => {
    expect(probed.after_use_page.failed_requests?.[0]).toMatchObject({
      frame_url: "https://pizza.example/pay",
    });
    expect(probed.page_left_behind.failed_requests?.[0]).toMatchObject({
      frame_url: "https://pizza.example/checkout",
    });
  });

  it("keeps a refusal it cannot attribute, claiming nothing about who asked", () => {
    expect(probed.unattributable.failed_requests?.[0]).toMatchObject({
      status: 403,
      url: "https://pizza.example/api/sw",
      frame_url: "",
    });
  });

  it("names nothing for a popup's opening navigation either, on purpose", () => {
    // window.open from a page outside the approved origins is the same smuggle
    // as the iframe, so an unresolvable frame stays unattributed here too.
    expect(probed.unattributable_navigation.failed_requests?.[0]).toMatchObject({
      url: "https://pizza.example/popup",
      frame_url: "",
    });
  });

  it("keeps nothing for a page that worked, redirects included", () => {
    expect(probed.quiet.failed_requests).toBeUndefined();
  });

  it("keeps the most recent few, most recent first", () => {
    const kept = probed.bounded.failed_requests ?? [];
    expect(kept.length).toBe(5);
    expect(kept.map((r) => r.url)).toEqual([
      "https://pizza.example/x8",
      "https://pizza.example/x7",
      "https://pizza.example/x6",
      "https://pizza.example/x5",
      "https://pizza.example/x4",
    ]);
  });

  it("survives a response that will not answer, and keeps the next one", () => {
    expect((probed.hostile.failed_requests ?? []).map((r) => r.status)).toEqual([401]);
  });
});
