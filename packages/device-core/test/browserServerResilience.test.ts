/** Browser-server resilience paths exercised without launching Camoufox. */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { havePython, runProbe } from "./pythonProbe.js";

const PROBE = fileURLToPath(
  new URL("../../../e2e/fixtures/browserResilienceProbe.py", import.meta.url),
);

describe.skipIf(!havePython())("the browser server resilience backstops", () => {
  const probed = runProbe<{
    stuck: { waited: [string, number][]; evaluated: boolean; masked: boolean };
    moved: { waited: [string, number][]; evaluated: boolean; masked: boolean };
    ubo_excluded: boolean;
  }>(PROBE);

  it("does not launch Camoufox with uBlock Origin", () => {
    expect(probed.ubo_excluded).toBe(true);
  });

  it("bounds the best-effort document check before evaluate", () => {
    expect(probed.stuck.waited).toEqual([["domcontentloaded", 1000]]);
    expect(probed.stuck.evaluated).toBe(false);
    // A timeout keeps the old safety ledger; it must not expose a value merely
    // because the page could not answer which document it is showing.
    expect(probed.stuck.masked).toBe(true);
  });

  it("still forgets masks after a completed new-document navigation", () => {
    expect(probed.moved.waited).toEqual([["domcontentloaded", 1000]]);
    expect(probed.moved.evaluated).toBe(true);
    expect(probed.moved.masked).toBe(false);
  });
});
