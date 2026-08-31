import { describe, expect, it } from "vitest";
import { deviceDisplayName, latchSessionName } from "../src/deviceNames.js";

describe("device display names", () => {
  it("uses Plow's collision-safe display name when registration returned one", () => {
    expect(deviceDisplayName("plucas-mbp.local (2)", "plucas-mbp.local"))
      .toBe("plucas-mbp.local (2)");
    expect(latchSessionName("plucas-mbp.local (2)", "plucas-mbp.local"))
      .toBe("Plow Latch (plucas-mbp.local (2))");
  });

  it("uses the hostname before registration and stays non-empty without a usable name", () => {
    expect(deviceDisplayName(null, "plucas-mbp.local")).toBe("plucas-mbp.local");
    expect(latchSessionName(null, "plucas-mbp.local")).toBe("Plow Latch (plucas-mbp.local)");
    expect(latchSessionName(null, "  ")).toBe("Plow Latch (Mac)");
    expect(deviceDisplayName("  ", "  ")).toBe("Mac");
  });
});
