import { describe, expect, it } from "vitest";
import { launchSessionWarning } from "../src/launchSession.js";

describe("launchSessionWarning", () => {
  it.each([
    ["Aqua", false],
    ["", false],
    ["Background", true],
    ["StandardIO", true],
    ["SomethingApplePutThereLater", true],
  ])("%s session warns: %s", (session, warns) => {
    expect(launchSessionWarning(session) !== null).toBe(warns);
  });

  it("names the session it found and the one move that fixes it", () => {
    const warning = launchSessionWarning("Background");
    expect(warning?.detail).toContain('"Background"');
    expect(warning?.detail).toContain("Finder");
    // The symptom, in the owner's words: the thing they will search for.
    expect(warning?.detail).toContain("say");
  });
});
