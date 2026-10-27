import { describe, expect, it, vi } from "vitest";
import { Session, type FrameLike, type HandleLike, type PageLike } from "../src/session.js";

/** Playwright's own refusal for a strict click that matched several elements.
 * It previews each element's text, so it must never reach the caller. */
const STRICT =
  "frame.click: Error: strict mode violation: locator('text=Send') resolved to 2 elements:\n" +
  '    1) <div contenteditable data-domo-secret>hunter2</div>';

const ADVICE =
  'Use a selector that names one, e.g. role=button[name="..."] or button:has-text("..."), ' +
  "pass frame, or click_at from a screenshot:";

/** A match that answers CANDIDATE_JS: its line, without the text when told. */
function candidate(line: string): HandleLike {
  return {
    evaluate: async (_fn: unknown, withText: unknown) => (withText === false ? line.replace(/ ".*"/, "") : line),
  } as unknown as HandleLike;
}

function frame(o: { click?: () => Promise<void>; matches?: string[] } = {}) {
  const click = vi.fn(o.click ?? (async () => {}));
  const matches = (o.matches ?? ["<button> \"Send\" (visible)"]).map(candidate);
  const self = {
    url: () => "https://example.test/preview",
    evaluate: async () => "doc-1",
    $: async () => matches[0] ?? null,
    $$: async () => matches,
    waitForSelector: async () => matches[0] ?? null,
    click,
    isDetached: () => false,
    parentFrame: () => null,
  } satisfies FrameLike;
  return { frame: self, click };
}

const strictFrame = (matches: string[]) =>
  frame({
    click: async () => {
      throw new Error(STRICT);
    },
    matches,
  });

function page(frames: FrameLike[]) {
  const self = {
    url: () => "https://example.test/preview",
    title: async () => "",
    frames: () => frames,
    context: () => ({ on: () => {}, pages: () => [self] }),
    evaluate: async () => "doc-1",
    goto: async () => undefined,
    goBack: async () => undefined,
    screenshot: async () => Buffer.alloc(0),
    innerText: async () => "",
    bringToFront: async () => {},
    waitForTimeout: async () => {},
    viewportSize: () => ({ width: 640, height: 480 }),
    mouse: { click: async () => {} },
  } satisfies PageLike;
  return self;
}

describe("click on a selector that matches several elements", () => {
  it("asks Playwright for a strict click", async () => {
    const f = frame();

    const result = await new Session(page([f.frame])).handle({ action: "click", selector: "button" });

    expect(result).toEqual({ ok: true, frame: 0 });
    expect(f.click).toHaveBeenCalledWith("button", expect.objectContaining({ strict: true }));
  });

  it.each([
    {
      name: "several matches → each candidate's tag, text and visibility",
      matches: ['<a> "Send and Request" (visible)', '<button> "Send" (visible)'],
      expected:
        `click refused: text=Send matches 2 elements. ${ADVICE}\n` +
        '  frame 0 #0: <a> "Send and Request" (visible)\n' +
        '  frame 0 #1: <button> "Send" (visible)',
    },
    {
      // PayPal's sign-in: `text=Log In` matched eleven hidden elements ahead of the button.
      name: "twelve matches → five named, visible first, the rest counted",
      matches: [...Array.from({ length: 11 }, (_, n) => `<p> "Log In help ${n}" (hidden)`), '<button> "Log In" (visible)'],
      expected: /:\n {2}frame 0 #11: <button> "Log In" \(visible\)\n {2}frame 0 #0: <p> "Log In help 0" \(hidden\)\n[^]* {2}frame 0 #3: <p> "Log In help 3" \(hidden\)\n {2}…and 7 more$/,
    },
    {
      name: "the page changed before they could be listed → Playwright's refusal is not passed on",
      matches: ['<button> "Send" (visible)'],
      expected: "click refused: text=Send matched several elements, and the page changed before they could be listed",
    },
  ])("$name", async ({ matches, expected }) => {
    const refusal = new Session(page([strictFrame(matches).frame])).handle({ action: "click", selector: "text=Send" });

    await expect(refusal).rejects.toThrow(expected);
    await expect(refusal).rejects.not.toThrow(/hunter2|Log In help 4/);
  });

  // Each frame passes strictness on its own; the click must not pick one.
  it("refuses a selector held by two frames without clicking either", async () => {
    const top = frame({ matches: ['<a> "Send and Request" (visible)'] });
    const inner = frame({ matches: ['<button> "Send" (visible)'] });

    const refusal = new Session(page([top.frame, inner.frame])).handle({ action: "click", selector: "text=Send" });

    await expect(refusal).rejects.toThrow(
      `click refused: text=Send matches 2 elements. ${ADVICE}\n` +
        '  frame 0 #0: <a> "Send and Request" (visible)\n' +
        '  frame 1 #0: <button> "Send" (visible)',
    );
    expect(top.click).not.toHaveBeenCalled();
    expect(inner.click).not.toHaveBeenCalled();
  });

  // A filled contenteditable's secret is its text, and neither its mark nor
  // its selector can be trusted to still find it, so while the ledger holds
  // anything the list carries no text at all — eval's own gate.
  it("names candidates without their text while a field the vault filled holds a value", async () => {
    const p = page([strictFrame(['<div> "hunter2" (visible)', '<div> "Plain" (visible)']).frame]);
    const session = new Session(p);
    // The ledger a masked fill leaves on this document (fillBranch.test.ts
    // covers how it gets there).
    const ledger = session as unknown as { masked: Map<PageLike, Set<string>>; seenDocument: Map<PageLike, string> };
    ledger.seenDocument.set(p, "doc-1");
    ledger.masked.set(p, new Set(["doc-1:[contenteditable]:empty"]));

    const refusal = session.handle({ action: "click", selector: "div" });

    await expect(refusal).rejects.toThrow(
      "click refused: div matches 2 elements (no text shown while a field the vault filled holds a value). " +
        `${ADVICE}\n  frame 0 #0: <div> (visible)\n  frame 0 #1: <div> (visible)`,
    );
    await expect(refusal).rejects.not.toThrow(/hunter2/);
  });

  it("clicks in the frame it is told to, when two hold the selector", async () => {
    const top = frame({ matches: ['<a> "Send and Request" (visible)'] });
    const inner = frame({ matches: ['<button> "Send" (visible)'] });

    const result = await new Session(page([top.frame, inner.frame])).handle({
      action: "click",
      selector: "text=Send",
      frame: 1,
    });

    expect(result).toEqual({ ok: true, frame: 1 });
    expect(top.click).not.toHaveBeenCalled();
  });
});
