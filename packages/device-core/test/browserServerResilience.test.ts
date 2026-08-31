/** Browser-server resilience paths exercised without launching Camoufox. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { havePython, runProbe } from "./pythonProbe.js";

const PROBE = fileURLToPath(
  new URL("../../../e2e/fixtures/browserResilienceProbe.py", import.meta.url),
);
const DEVICE_AGENT = fileURLToPath(new URL("../src/deviceAgent.ts", import.meta.url));

function hostCapMs(): number {
  const source = fs.readFileSync(DEVICE_AGENT, "utf8");
  const match = /actionTimeoutMs:\s*([\d_]+)/.exec(source);
  if (!match) throw new Error("actionTimeoutMs not found in deviceAgent.ts");
  return Number(match[1].replace(/_/g, ""));
}

describe.skipIf(!havePython())("the browser server resilience backstops", () => {
  const probed = runProbe<{
    wedge: {
      load_state_responsive: boolean;
      driver_calls: { kind: string; timeout: number }[];
      page_evaluated: boolean;
      masked: boolean;
    };
    moved: {
      driver_calls: { kind: string; timeout: number }[];
      page_evaluated: boolean;
      masked: boolean;
    };
    goto: {
      driver_calls: { kind: string; timeout: number }[];
      page_evaluated: boolean;
      goto_args: [string, number, string][];
      settles: number[];
      title_called: boolean;
      result: Record<string, unknown> | null;
      error: string | null;
    };
    constants: { navigation_timeout_ms: number; settle_ms: number };
    ubo_excluded: boolean;
  }>(PROBE);

  it("does not launch Camoufox with uBlock Origin", () => {
    expect(probed.ubo_excluded).toBe(true);
  });

  it("driver-bounds the document check when load state answers but page evaluate wedges", () => {
    expect(probed.wedge.load_state_responsive).toBe(true);
    expect(probed.wedge.driver_calls).toEqual([
      { kind: "match", timeout: 500 },
      { kind: "stamp", timeout: 500 },
    ]);
    expect(probed.wedge.page_evaluated).toBe(false);
    // A timeout keeps the old safety ledger; it must not expose a value merely
    // because the page could not answer which document it is showing.
    expect(probed.wedge.masked).toBe(true);
  });

  it("still forgets masks after a completed new-document navigation", () => {
    expect(probed.moved.driver_calls).toEqual([
      { kind: "match", timeout: 500 },
      { kind: "stamp", timeout: 500 },
    ]);
    expect(probed.moved.page_evaluated).toBe(false);
    expect(probed.moved.masked).toBe(false);
  });

  it("keeps goto to its navigation and settle budgets, with no pre-check or title read", () => {
    expect(probed.goto.driver_calls).toEqual([]);
    expect(probed.goto.page_evaluated).toBe(false);
    expect(probed.goto.goto_args).toEqual([
      ["https://example.test/", probed.constants.navigation_timeout_ms, "domcontentloaded"],
    ]);
    expect(probed.goto.settles).toEqual([probed.constants.settle_ms]);
    expect(probed.goto.title_called).toBe(false);
    expect(probed.goto.result).toEqual({});
    expect(probed.goto.error).toBeNull();
    expect(probed.constants.navigation_timeout_ms + probed.constants.settle_ms)
      .toBeLessThan(hostCapMs());
  });
});
