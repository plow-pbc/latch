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
  failed_requests?: { status: number; method: string; url: string }[];
}

describe.skipIf(!havePython())("the real response listener in server.py", () => {
  const probed = runProbe<{
    listens: string[];
    refused: Envelope;
    drained: Envelope;
    quiet: Envelope;
    bounded: Envelope;
    hostile: Envelope;
  }>(PROBE);

  it("listens on the context, so a popup's refusals count too", () => {
    expect(probed.listens).toEqual(["response"]);
  });

  it("keeps a refusal without its query or its userinfo", () => {
    expect(probed.refused.failed_requests).toEqual([
      {
        status: 429,
        method: "POST",
        url: "https://signin.example/tenant/SelfAsserted",
        retry_after: "30",
        server: "cloudfront",
      },
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
