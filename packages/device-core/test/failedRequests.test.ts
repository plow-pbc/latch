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
    page_navigating_itself: Envelope;
    during_a_device_goto: Envelope;
    flag_during: { goto: boolean; back: boolean };
    flag_after: { goto: boolean; back: boolean };
    unattributable: Envelope;
    drained: Envelope;
    quiet: Envelope;
    bounded: Envelope;
  }>(PROBE);

  it("listens on the context, so a popup's refusals count too", () => {
    expect(probed.listens).toEqual(["response"]);
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

  it("names a page that navigated ITSELF, not the host it aimed at", () => {
    // Otherwise a locked-out page points itself at an approved host and the
    // refusal reads as that host's own trouble.
    expect((probed.page_navigating_itself.failed_requests ?? []).map((r) => r.initiator))
      .toEqual(["https://offsite.example", "https://offsite.example"]);
  });

  it("raises the device-navigation flag for goto and back, and lowers it after", () => {
    // The flag is what the attribution gate reads, so both branches that set it
    // are driven through the real handler rather than assigned by hand.
    expect(probed.flag_during).toEqual({ goto: true, back: true });
    expect(probed.flag_after).toEqual({ goto: false, back: false });
  });

  it("lets only the goto's own navigation answer for itself, in its own window", () => {
    // Three refusals arrive while a device goto is in flight, most recent
    // first. Only the main frame's navigation is the device's asking. The
    // subresource is named by the page being left (what the main frame still
    // says at that moment) and the child frame's navigation by that frame —
    // which is also what says the initiator is read from the RESPONSE's frame.
    expect((probed.during_a_device_goto.failed_requests ?? [])
      .map((r) => [r.status, r.initiator])).toEqual([
      [404, "https://widget.example"],
      [403, "https://offsite.example"],
      [429, "https://pizza.example"],
    ]);
  });

  it("names nobody when the frame will not answer", () => {
    // A service worker, a blank child frame — the device withholds these from
    // the agent rather than guessing, and the owner still sees them.
    expect(probed.unattributable.failed_requests?.[0]).toMatchObject({ initiator: "" });
  });

  it("hands each refusal over once, so the next reply is not told again", () => {
    expect(probed.drained.failed_requests).toBeUndefined();
  });

  it("keeps nothing for a page that worked, redirects included", () => {
    expect(probed.quiet.failed_requests).toBeUndefined();
  });

  it("keeps the most recent few, most recent first", () => {
    const kept = probed.bounded.failed_requests ?? [];
    expect(kept.length).toBe(5);
    expect(kept.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
  });

});
