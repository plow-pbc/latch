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
    initiators: Envelope;
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

  it("names who asked, with a navigation answering for itself", () => {
    // The frame still names the page being left while a navigation's headers
    // arrive, so a refused goto would otherwise look like somebody else's.
    expect((probed.initiators.failed_requests ?? []).map((r) => r.initiator)).toEqual([
      "https://pizza.example",
      "https://offsite.example",
    ]);
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
