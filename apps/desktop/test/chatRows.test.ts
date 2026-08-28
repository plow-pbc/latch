import { describe, expect, it } from "vitest";
import { chatRowSubtitle, chatRowTitle, formatNumber, type ChatPerson } from "../src/chatRows.js";

const LINE = "+16503156536";
const person = (over: Partial<ChatPerson> = {}): ChatPerson => ({
  number: "+13305541942",
  name: null,
  isOwner: false,
  ...over,
});

describe("formatNumber", () => {
  it("spells a NANP number the way a human reads it", () => {
    expect(formatNumber("+16503156536")).toBe("+1 650-315-6536");
  });

  it.each([
    ["a longer country code", "+442071838750"],
    ["something that is not a number", "not a number"],
    ["an empty string", ""],
  ])("returns %s verbatim rather than mis-grouping it", (_why, raw) => {
    // Chopping an unknown shape into NANP groups would print a number that
    // does not exist, which is worse than printing the one we were given.
    expect(formatNumber(raw)).toBe(raw.trim());
  });
});

describe("the chat row's title", () => {
  it("names the people, and the owner as You", () => {
    // The owner comes from the API's own `role === "owner"` — not from a
    // number that happens to recur, which is wrong for a one-chat account and
    // for a household where the same second person is in every chat.
    expect(
      chatRowTitle(
        [person({ isOwner: true }), person({ number: "+19165204946", name: "Ash" })],
        LINE,
        "fallback",
      ),
    ).toBe("You, Ash");
  });

  it("leaves the line out — it is Plow's number, not a participant", () => {
    // Every chat on one line looked alike while the line was in the title.
    const title = chatRowTitle(
      [person({ number: LINE, name: "Ash" }), person({ number: "+19165204946", name: "Robin" })],
      LINE,
      "fallback",
    );
    expect(title).toBe("Robin");
    expect(title).not.toContain("650");
  });

  it("falls back to the number when a member has no name", () => {
    expect(chatRowTitle([person({ number: "+19165204946" })], LINE, "fallback")).toBe(
      "+1 916-520-4946",
    );
  });

  it("uses the fallback when dropping the line leaves nobody", () => {
    // Real: a 1:1 between the owner and the line, and the settings fallback
    // chat, which persists a label and no participants at all.
    expect(chatRowTitle([person({ number: LINE })], LINE, "cht_abc")).toBe("cht_abc");
    expect(chatRowTitle([], null, "cht_abc")).toBe("cht_abc");
  });
});

describe("the chat row's subtitle", () => {
  it("names the line once, then who it reaches", () => {
    expect(
      chatRowSubtitle(LINE, "Ash", [
        person({ isOwner: true }),
        person({ number: "+19165204946" }),
      ]),
    ).toBe("Ash · +1 650-315-6536 — You +1 330-554-1942, +1 916-520-4946");
  });

  it("prints the line exactly once, and never in the title", () => {
    // A number printed twice on one row reads as two numbers.
    const people = [person({ number: LINE }), person({ isOwner: true })];
    const subtitle = chatRowSubtitle(LINE, "Ash", people);
    expect(subtitle.match(/650-315-6536/g)).toHaveLength(1);
    expect(chatRowTitle(people, LINE, "x")).not.toContain("650");
  });

  it("stays one line for three participants", () => {
    const subtitle = chatRowSubtitle(LINE, "Ash", [
      person({ isOwner: true }),
      person({ number: "+19165204946", name: "Robin" }),
      person({ number: "+14155550188" }),
    ]);
    expect(subtitle).toBe(
      "Ash · +1 650-315-6536 — You +1 330-554-1942, Robin +1 916-520-4946, +1 415-555-0188",
    );
    expect(subtitle).not.toContain("\n");
  });

  it("drops the unnamed line's separator rather than printing a bare dot", () => {
    expect(chatRowSubtitle(LINE, null, [person({ isOwner: true })])).toBe(
      "+1 650-315-6536 — You +1 330-554-1942",
    );
  });

  it("says only the line when it reaches nobody else", () => {
    expect(chatRowSubtitle(LINE, "Ash", [person({ number: LINE })])).toBe("Ash · +1 650-315-6536");
  });

  it("is empty when there is no line and nobody to name", () => {
    // The settings fallback chat: a uid and a label, and nothing to address.
    expect(chatRowSubtitle(null, null, [])).toBe("");
  });
});
