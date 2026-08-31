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
    poisoned: {
      first: {
        driver_calls: { kind: string; timeout: number }[];
        masked: boolean;
        seen: string;
      };
      later_driver_calls: { kind: string; timeout: number }[];
      masked: boolean;
      seen: string;
      handle_reads: number;
      handle_disposals: number;
    };
    marker_getter: {
      driver_calls: { kind: string; timeout: number }[];
      masked: boolean;
      seen: string;
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
    back: {
      driver_calls: { kind: string; timeout: number }[];
      back_args: [number, string][];
      settles: number[];
      title_called: boolean;
      result: Record<string, unknown> | null;
      error: string | null;
    };
    use_page: {
      driver_calls: { kind: string; timeout: number }[];
      brought_to_front: boolean;
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
      { kind: "token", timeout: 1000 },
    ]);
    expect(probed.wedge.page_evaluated).toBe(false);
    // A timeout keeps the old safety ledger; it must not expose a value merely
    // because the page could not answer which document it is showing.
    expect(probed.wedge.masked).toBe(true);
  });

  it("still forgets masks after a completed new-document navigation", () => {
    expect(probed.moved.driver_calls).toEqual([
      { kind: "token", timeout: 1000 },
    ]);
    expect(probed.moved.page_evaluated).toBe(false);
    expect(probed.moved.masked).toBe(false);
  });

  it("adopts a token minted by another code path and converges on later checks", () => {
    expect(probed.poisoned.first).toEqual({
      driver_calls: [{ kind: "token", timeout: 1000 }],
      masked: false,
      seen: "doc-minted-elsewhere",
    });
    expect(probed.poisoned.later_driver_calls).toEqual([
      { kind: "token", timeout: 1000 },
    ]);
    expect(probed.poisoned.masked).toBe(false);
    expect(probed.poisoned.seen).toBe("doc-minted-elsewhere");
    expect(probed.poisoned.handle_reads).toBe(2);
    expect(probed.poisoned.handle_disposals).toBe(2);
  });

  it("does not trust a document-token getter error that contains an old marker", () => {
    expect(probed.marker_getter.driver_calls).toEqual([
      { kind: "token", timeout: 1000 },
    ]);
    expect(probed.marker_getter.masked).toBe(true);
    expect(probed.marker_getter.seen).toBe("doc-old");
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

  it("keeps back to its navigation and settle budgets, with no pre-check or title read", () => {
    expect(probed.back.driver_calls).toEqual([]);
    expect(probed.back.back_args).toEqual([
      [probed.constants.navigation_timeout_ms, "domcontentloaded"],
    ]);
    expect(probed.back.settles).toEqual([probed.constants.settle_ms]);
    expect(probed.back.title_called).toBe(false);
    expect(probed.back.result).toEqual({ moved: true });
    expect(probed.back.error).toBeNull();
    expect(probed.constants.navigation_timeout_ms + probed.constants.settle_ms)
      .toBeLessThan(hostCapMs());
  });

  it("switches pages without checking the abandoned page or reading a title", () => {
    expect(probed.use_page.driver_calls).toEqual([]);
    expect(probed.use_page.brought_to_front).toBe(true);
    expect(probed.use_page.title_called).toBe(false);
    expect(probed.use_page.result).toEqual({ ok: true });
    expect(probed.use_page.error).toBeNull();
  });
});
