/**
 * The vault-pick step's row filter: pure functions pulled out of the Import
 * sheet's closure so they can be tested without a DOM. `rowsFor`'s `at`
 * values are what `vault:importCommit` relies on — ORIGINAL indices into
 * `p.items`, main's staged order.
 */
import { describe, expect, it } from "vitest";
import { rowsFor, vaultsOf } from "../src/renderer/vaultImport.js";

const item = (vault: string) => ({ vault });
const skip = (vault: string | undefined) => ({ vault, title: "x", reason: "y" });

describe("rowsFor", () => {
  // Vaults A, B, A, C (an item's vault can repeat) and one skipped row per
  // vault plus one with no vault — shared across every case below.
  const p = {
    items: [item("A"), item("B"), item("A"), item("C")],
    skipped: [skip("A"), skip("B"), skip(undefined)],
  };

  it.each([
    { case: "a pick of one of three vaults keeps only its rows", vaultPick: new Set(["B"]), at: [1], skippedVaults: ["B", undefined] },
    { case: "picking a vault used twice keeps both original indices", vaultPick: new Set(["A"]), at: [0, 2], skippedVaults: ["A", undefined] },
    { case: "no pick keeps every item and every skipped row", vaultPick: null, at: [0, 1, 2, 3], skippedVaults: ["A", "B", undefined] },
  ])("$case", ({ vaultPick, at, skippedVaults }) => {
    const { items, skipped } = rowsFor(p, vaultPick);
    expect(items.map((r) => r.at)).toEqual(at);
    expect(skipped.map((s) => s.vault)).toEqual(skippedVaults);
  });
});

describe("vaultsOf", () => {
  it("lists a vault present only in skipped rows", () => {
    const p = { items: [item("A")], skipped: [skip("B")] };
    expect(vaultsOf(p)).toEqual(["A", "B"]);
  });
});
