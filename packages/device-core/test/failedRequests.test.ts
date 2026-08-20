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


  it("will not credit a background popup's navigation to the url it was pointed at", () => {
    // Otherwise a locked page opens a popup, points it at an approved host, and
    // the path it chose is handed to the agent as the approved page's own.
    expect(probed.background_navigation.failed_requests?.[0]).toMatchObject({
      url: "https://pizza.example/anything-it-likes",
      frame_url: "https://offsite.example/lander",
    });
  });

  it("attributes a refused navigation to the page asked for, not the one being left", () => {
    // Otherwise a goto that comes back 429 is credited to the previous page and
    // withheld from the agent that asked for the new one.
    expect(probed.navigation.failed_requests?.[0]).toMatchObject({
      url: "https://pizza.example/checkout",
      frame_url: "https://pizza.example/checkout",
    });
  });

  it("records what the goto asked for, stripped, on the way in", () => {
    // The plumbing, not just the predicate: the real command handler ran.
    expect(probed.navigation_asked_for).toBe("https://pizza.example/checkout?tx=SECRET");
  });

  it("walks a sign-in-length chain — the browser's full 20 redirects — back to what was asked for", () => {
    expect(probed.long_chain.failed_requests?.[0]).toMatchObject({
      url: "https://signin.pizza.example/b2c/end",
      frame_url: "https://signin.pizza.example/b2c/end",
    });
  });

  it("leaves nothing behind for a page to navigate into once the goto returned", () => {
    // The pointer lives only while the navigation is in flight, so there is no
    // stale target for back, use_page, or a scripted location to claim.
    expect(probed.after_the_goto_returned.failed_requests?.[0]).toMatchObject({
      url: "https://pizza.example/pay",
      frame_url: "https://pizza.example/cart",
    });
  });

  it("gives up on a redirect chain longer than the browser's own ceiling", () => {
    expect(probed.over_the_hop_limit.failed_requests?.[0]).toMatchObject({
      url: "https://pizza.example/end",
      frame_url: "https://pizza.example/cart",
    });
  });

  it("follows the redirect chain back to what the agent asked for", () => {
    expect(probed.redirected_navigation.failed_requests?.[0]).toMatchObject({
      url: "https://signin.pizza.example/b2c",
      frame_url: "https://signin.pizza.example/b2c",
    });
  });

  it("will not let a page navigating itself claim to be the agent's goto", () => {
    expect(probed.self_navigation.failed_requests?.[0]).toMatchObject({
      url: "https://pizza.example/anything-it-likes",
      frame_url: "https://offsite.example/lander",
    });
  });

  it("follows use_page: the agent drives the page it switched to, not the one it left", () => {
    expect(probed.after_use_page.failed_requests?.[0]).toMatchObject({
      frame_url: "https://pizza.example/pay",
    });
    expect(probed.page_left_behind.failed_requests?.[0]).toMatchObject({
      frame_url: "https://pizza.example/checkout",
    });
  });

  it("credits a subframe's navigation to whoever embedded it", () => {
    expect(probed.subframe_navigation.failed_requests?.[0]).toMatchObject({
      url: "https://pizza.example/anything-it-likes",
      frame_url: "https://offsite.example/lander",
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
