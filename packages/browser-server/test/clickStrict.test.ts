import { describe, expect, it, vi } from "vitest";
import { Session, type FrameLike, type HandleLike, type PageLike } from "../src/session.js";

/** Playwright's own refusal for a strict click that matched several elements. */
const STRICT = "frame.click: Error: strict mode violation: locator('text=Send') resolved to 2 elements";

function candidate(line: string): HandleLike {
  return { evaluate: async () => line } as unknown as HandleLike;
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

  it("refuses, naming each candidate's tag, text and visibility", async () => {
    const f = frame({
      click: async () => {
        throw new Error(STRICT);
      },
      matches: ['<a> "Send and Request" (visible)', '<button> "Send" (visible)'],
    });

    const refusal = new Session(page([f.frame])).handle({ action: "click", selector: "text=Send" });

    await expect(refusal).rejects.toThrow(
      'click refused: text=Send matches 2 elements. Use a selector that names one, ' +
        'e.g. role=button[name="..."] or button:has-text("..."), or click_at from a screenshot:\n' +
        '  0: <a> "Send and Request" (visible)\n' +
        '  1: <button> "Send" (visible)',
    );
  });

  it("names five candidates, visible first, and counts the rest, so the refusal fits the error cut", async () => {
    // PayPal's sign-in: `text=Log In` matched eleven hidden elements ahead of the button.
    const many = [...Array.from({ length: 11 }, (_, n) => `<p> "Log In help ${n}" (hidden)`), '<button> "Log In" (visible)'];
    const f = frame({
      click: async () => {
        throw new Error(STRICT);
      },
      matches: many,
    });

    const refusal = new Session(page([f.frame])).handle({ action: "click", selector: "text=Log In" });

    await expect(refusal).rejects.toThrow(
      /screenshot:\n {2}11: <button> "Log In" \(visible\)\n {2}0: <p> "Log In help 0" \(hidden\)\n[^]* {2}3: <p> "Log In help 3" \(hidden\)\n {2}…and 7 more$/,
    );
    await expect(refusal).rejects.not.toThrow(/Log In help 4/);
  });

  it("does not try the next frame: that would be the same guess one level up", async () => {
    const ambiguous = frame({
      click: async () => {
        throw new Error(STRICT);
      },
      matches: ['<a> "Send and Request" (visible)', '<button> "Send" (visible)'],
    });
    const single = frame();

    const refusal = new Session(page([ambiguous.frame, single.frame])).handle({
      action: "click",
      selector: "text=Send",
    });

    await expect(refusal).rejects.toThrow(/matches 2 elements/);
    expect(single.click).not.toHaveBeenCalled();
  });

  it("keeps Playwright's refusal when the page no longer holds several matches", async () => {
    const f = frame({
      click: async () => {
        throw new Error(STRICT);
      },
      matches: ['<button> "Send" (visible)'],
    });

    const refusal = new Session(page([f.frame])).handle({ action: "click", selector: "text=Send" });

    await expect(refusal).rejects.toThrow(STRICT);
  });
});
