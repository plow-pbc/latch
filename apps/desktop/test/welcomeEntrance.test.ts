import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FONT_WAIT_CEILING_MS,
  startAfterDocumentPaint,
} from "../src/renderer/welcomeEntrance.js";

async function settlePromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("the welcome entrance clock", () => {
  afterEach(() => vi.useRealTimers());

  it("does not start while fonts or the first painted frame are stalled", async () => {
    vi.useFakeTimers();
    let fontsLoaded!: () => void;
    const fontsReady = new Promise<void>((resolve) => {
      fontsLoaded = resolve;
    });
    const frames: FrameRequestCallback[] = [];
    const start = vi.fn();
    const entrance = startAfterDocumentPaint(start, {
      fontsReady,
      requestFrame: (callback) => {
        frames.push(callback);
        return 0;
      },
    });

    await settlePromises();
    expect(frames).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();

    fontsLoaded();
    await settlePromises();
    expect(frames).toHaveLength(1);

    frames.shift()?.(16);
    expect(frames).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();

    frames.shift()?.(1_516);
    await entrance;
    expect(start).toHaveBeenCalledOnce();
  });

  it("starts after the font wait ceiling when fonts remain pending", async () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    const start = vi.fn();
    const entrance = startAfterDocumentPaint(start, {
      fontsReady: new Promise(() => {}),
      requestFrame: (callback) => {
        frames.push(callback);
        return 0;
      },
    });

    await settlePromises();
    vi.advanceTimersByTime(FONT_WAIT_CEILING_MS - 1);
    await settlePromises();
    expect(frames).toHaveLength(0);

    vi.advanceTimersByTime(1);
    await settlePromises();
    expect(frames).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();

    frames.shift()?.(FONT_WAIT_CEILING_MS);
    frames.shift()?.(FONT_WAIT_CEILING_MS + 16);
    await entrance;
    expect(start).toHaveBeenCalledOnce();
  });
});
