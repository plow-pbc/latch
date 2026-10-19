import { describe, expect, it } from "vitest";
import {
  presetFor,
  rowView,
  UNAVAILABLE_REASON,
  verdictWord,
} from "../src/renderer/gatekeeperRows.js";

describe("gatekeeper preview rows", () => {
  it.each([
    [null, { state: "checking", reason: "" }],
    [{ verdict: "allow", reason: "Fits what you asked." }, { state: "ok", reason: "Fits what you asked." }],
    [{ verdict: "deny", reason: "Outside what you asked, or you ruled it out." }, { state: "no", reason: "Outside what you asked, or you ruled it out." }],
    [{ verdict: "ask", reason: "" }, { state: "unavailable", reason: UNAVAILABLE_REASON }],
    [{ verdict: "ask", reason: "anything" }, { state: "unavailable", reason: UNAVAILABLE_REASON }],
  ])("shows %j as %j", (result, view) => {
    expect(rowView(result)).toEqual(view);
  });

  it.each([
    ["ok", "Allowed"],
    ["no", "Denied"],
    ["unavailable", "Couldn't check"],
    ["checking", "Analyzing…"],
  ])("labels a %s row's verdict %s", (state, word) => {
    expect(verdictWord(state)).toBe(word);
  });

  it("names the preset whose instructions are in the field, and none once edited", () => {
    const presets = { home: { text: "Allow home." }, work: { text: "Allow work." } };
    expect(presetFor("Allow work.", presets)).toBe("work");
    expect(presetFor("Allow work. And more.", presets)).toBeNull();
  });
});
