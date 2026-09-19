import { describe, expect, it } from "vitest";
import {
  NO_CREDITS_REASON,
  presetFor,
  rowView,
  UNAVAILABLE_REASON,
} from "../src/renderer/gatekeeperRows.js";

describe("gatekeeper preview rows", () => {
  it.each([
    [null, { state: "checking", reason: "" }],
    [{ verdict: "allow", reason: "Calendar is allowed." }, { state: "ok", reason: "Calendar is allowed." }],
    [{ verdict: "deny", reason: "Never share documents." }, { state: "no", reason: "Never share documents." }],
    [{ verdict: "ask", reason: "insufficient Plow balance", cause: "no_credits" }, { state: "unavailable", reason: NO_CREDITS_REASON }],
    [{ verdict: "ask", reason: "reviewer timed out", cause: "unavailable" }, { state: "unavailable", reason: UNAVAILABLE_REASON }],
    [{ verdict: "ask", reason: "anything" }, { state: "unavailable", reason: UNAVAILABLE_REASON }],
  ])("shows %j as %j", (result, view) => {
    expect(rowView(result)).toEqual(view);
  });

  it("names the preset whose instructions are in the field, and none once edited", () => {
    const presets = { home: { text: "Allow home." }, work: { text: "Allow work." } };
    expect(presetFor("Allow work.", presets)).toBe("work");
    expect(presetFor("Allow work. And more.", presets)).toBeNull();
  });
});
