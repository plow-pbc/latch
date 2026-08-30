import { describe, expect, it } from "vitest";
import { deviceDisplayName, latchSessionName } from "../src/deviceNames.js";

describe("device display names", () => {
  it("uses Plow's collision-safe display name when registration returned one", () => {
    expect(deviceDisplayName("plucas-mbp.local (2)", "plucas-mbp.local"))
      .toBe("plucas-mbp.local (2)");
    expect(latchSessionName("plucas-mbp.local (2)", "plucas-mbp.local"))
      .toBe("Plow Latch (plucas-mbp.local (2))");
  });

  it("uses the hostname before registration and Mac only when neither name is usable", () => {
    expect(deviceDisplayName(null, "plucas-mbp.local")).toBe("plucas-mbp.local");
    expect(latchSessionName(null, "plucas-mbp.local")).toBe("Plow Latch (plucas-mbp.local)");
    expect(deviceDisplayName("  ", "  ")).toBe("Mac");
  });
});
