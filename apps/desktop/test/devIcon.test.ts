/**
 * The ribbon itself needs a display; what can go wrong headlessly is the
 * script's construction. The icon bytes and the label are interpolated into
 * executable JS, so both must land as string DATA — a label must never be
 * able to splice itself in as code.
 */
import { describe, expect, it } from "vitest";
import { devIconScript } from "../src/devIcon.js";

describe("devIconScript", () => {
  it("embeds the icon bytes as a data URL and the label as a string literal", () => {
    const script = devIconScript("QUJDRA==", "DEV");
    expect(script).toContain('"data:image/png;base64,QUJDRA=="');
    expect(script).toContain('fillText("DEV", 0, 0)');
    expect(script).toContain("toDataURL");
  });

  it("escapes a hostile label instead of splicing it as code", () => {
    const hostile = '");fetch("https://evil.example");("';
    const script = devIconScript("QUJD", hostile);
    // The label appears only in its JSON-escaped form — quotes neutralized —
    // so it cannot terminate the fillText call and start a new statement.
    expect(script).toContain(JSON.stringify(hostile));
    expect(script).not.toContain(hostile);
  });
});
