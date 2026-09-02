/**
 * The Import sheet's one pure function, pulled out of its closure so it can be
 * tested without a DOM: which vaults a preview spans. More than one is what
 * makes the vault step a step at all — and main answers the same question by
 * the same rule (importVaults, device-core), over the parse rather than the
 * preview.
 */
import { describe, expect, it } from "vitest";
import { vaultsOf } from "../src/renderer/vaultImport.js";

describe("vaultsOf", () => {
  const skip = (vault: string | undefined) => ({ vault, title: "x", reason: "y" });

  it.each([
    { case: "lists each vault once, in first-seen order", p: { items: [{ vault: "A" }, { vault: "B" }, { vault: "A" }], skipped: [] }, want: ["A", "B"] },
    { case: "lists a vault present only in skipped rows", p: { items: [{ vault: "A" }], skipped: [skip("B")] }, want: ["A", "B"] },
    { case: "names none for a source that knows no vaults", p: { items: [{}], skipped: [skip(undefined)] }, want: [] },
  ])("$case", ({ p, want }) => {
    expect(vaultsOf(p)).toEqual(want);
  });
});
