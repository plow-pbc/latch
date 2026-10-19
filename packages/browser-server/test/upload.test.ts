import { describe, expect, it, vi } from "vitest";
import { Session, type FrameLike, type HandleLike, type PageLike } from "../src/session.js";

function frame(input: HandleLike | null) {
  const waitForSelector = vi.fn(async () => {
    if (input === null) throw new Error("Timeout 3000ms exceeded");
    return input;
  });
  const self = {
    url: () => "https://example.test/post",
    evaluate: async () => "doc-1",
    $: async () => input,
    $$: async () => (input === null ? [] : [input]),
    waitForSelector,
    click: async () => {},
    isDetached: () => false,
    parentFrame: () => null,
  } satisfies FrameLike;
  return { frame: self, waitForSelector };
}

function page(frames: FrameLike[]) {
  const self = {
    url: () => "https://example.test/post",
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

describe("upload", () => {
  // #163: the page's own button opens the native picker; the input behind it
  // is usually hidden, so it is waited for attached, not visible.
  it("sets the file on a hidden input, searching the frames for it", async () => {
    const setInputFiles = vi.fn(async () => {});
    const input = { setInputFiles } as unknown as HandleLike;
    const top = frame(null);
    const inner = frame(input);

    const result = await new Session(page([top.frame, inner.frame])).handle({
      action: "upload",
      selector: "input[type=file]",
      path: "/Users/o/clip.mov",
    });

    expect(result).toEqual({ ok: true, frame: 1 });
    expect(inner.waitForSelector).toHaveBeenCalledWith("input[type=file]", expect.objectContaining({ state: "attached" }));
    expect(setInputFiles).toHaveBeenCalledWith("/Users/o/clip.mov", expect.anything());
  });

  it("says which selector it could not find", async () => {
    const refusal = new Session(page([frame(null).frame])).handle({
      action: "upload",
      selector: "#nope",
      path: "/Users/o/clip.mov",
    });

    await expect(refusal).rejects.toThrow("Timeout 3000ms exceeded");
  });
});
