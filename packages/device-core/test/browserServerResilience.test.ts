/** Browser-server resilience paths exercised without launching Camoufox. */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { BROWSER_ACTION_TIMEOUT_MS } from "../src/deviceAgent.js";
import { havePython, runProbe } from "./pythonProbe.js";

const PROBE = fileURLToPath(
  new URL("../../../e2e/fixtures/browserResilienceProbe.py", import.meta.url),
);

describe.skipIf(!havePython())("the browser server resilience backstops", () => {
  const probed = runProbe<{
    wedge: {
      driver_calls: { kind: string; selector: string; timeout: number }[];
      page_evaluated: boolean;
      masked: boolean;
    };
    moved: {
      driver_calls: { kind: string; selector: string; timeout: number }[];
      page_evaluated: boolean;
      masked: boolean;
    };
    poisoned: {
      first: {
        driver_calls: { kind: string; selector: string; timeout: number }[];
        masked: boolean;
        seen: string;
      };
      later_driver_calls: { kind: string; selector: string; timeout: number }[];
      masked: boolean;
      seen: string;
    };
    throwing_getter: {
      masked: boolean;
      seen: string;
    };
    goto: {
      driver_calls: { kind: string; timeout: number }[];
      page_evaluated: boolean;
      goto_args: [string, number, string][];
      settles: number[];
      result: Record<string, unknown>;
    };
    back: {
      driver_calls: { kind: string; timeout: number }[];
      back_args: [number, string][];
      settles: number[];
      result: Record<string, unknown>;
    };
    use_page: {
      driver_calls: { kind: string; timeout: number }[];
      brought_to_front: boolean;
      result: Record<string, unknown>;
    };
    constants: { navigation_timeout_ms: number; settle_ms: number };
    ubo_excluded: boolean;
  }>(PROBE);

  it("does not launch Camoufox with uBlock Origin", () => {
    expect(probed.ubo_excluded).toBe(true);
  });

  it("routes the document check through one timed locator evaluation", () => {
    expect(probed.wedge.driver_calls).toEqual([
      { kind: "token", selector: ":root", timeout: 1000 },
    ]);
    expect(probed.wedge.page_evaluated).toBe(false);
    // A timeout keeps the old safety ledger; it must not expose a value merely
    // because the page could not answer which document it is showing.
    expect(probed.wedge.masked).toBe(true);
  });

  it("still forgets masks after a completed new-document navigation", () => {
    expect(probed.moved.driver_calls).toEqual([
      { kind: "token", selector: ":root", timeout: 1000 },
    ]);
    expect(probed.moved.page_evaluated).toBe(true);
    expect(probed.moved.masked).toBe(false);
  });

  it("adopts a token minted by another code path and converges on later checks", () => {
    expect(probed.poisoned.first).toEqual({
      driver_calls: [{ kind: "token", selector: ":root", timeout: 1000 }],
      masked: false,
      seen: "doc-minted-elsewhere",
    });
    expect(probed.poisoned.later_driver_calls).toEqual([
      { kind: "token", selector: ":root", timeout: 1000 },
    ]);
    expect(probed.poisoned.masked).toBe(false);
    expect(probed.poisoned.seen).toBe("doc-minted-elsewhere");
  });

  it("keeps masks when the document-token getter throws", () => {
    expect(probed.throwing_getter.masked).toBe(true);
    expect(probed.throwing_getter.seen).toBe("doc-old");
  });

  it("keeps goto to its navigation and settle budgets, with no pre-check or title read", () => {
    expect(probed.goto.driver_calls).toEqual([]);
    expect(probed.goto.page_evaluated).toBe(false);
    expect(probed.goto.goto_args).toEqual([
      ["https://example.test/", probed.constants.navigation_timeout_ms, "domcontentloaded"],
    ]);
    expect(probed.goto.settles).toEqual([probed.constants.settle_ms]);
    expect(probed.goto.result).toEqual({});
    expect(probed.constants.navigation_timeout_ms + probed.constants.settle_ms)
      .toBeLessThan(BROWSER_ACTION_TIMEOUT_MS);
  });

  it("keeps back to its navigation and settle budgets, with no pre-check or title read", () => {
    expect(probed.back.driver_calls).toEqual([]);
    expect(probed.back.back_args).toEqual([
      [probed.constants.navigation_timeout_ms, "domcontentloaded"],
    ]);
    expect(probed.back.settles).toEqual([probed.constants.settle_ms]);
    expect(probed.back.result).toEqual({ moved: true });
    expect(probed.constants.navigation_timeout_ms + probed.constants.settle_ms)
      .toBeLessThan(BROWSER_ACTION_TIMEOUT_MS);
  });

  it("switches pages without checking the abandoned page or reading a title", () => {
    expect(probed.use_page.driver_calls).toEqual([]);
    expect(probed.use_page.brought_to_front).toBe(true);
    expect(probed.use_page.result).toEqual({ ok: true });
  });
});
