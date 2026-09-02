import { describe, expect, it, vi } from "vitest";
import { startAfterDocumentPaint } from "../src/renderer/welcomeEntrance.js";

describe("the welcome entrance clock", () => {
  it("does not start while fonts or the first painted frame are stalled", async () => {
    let fontsLoaded!: () => void;
    const fontsReady = new Promise<void>((resolve) => {
      fontsLoaded = resolve;
    });
    const frames: FrameRequestCallback[] = [];
    const tasks: Array<() => void> = [];
    const start = vi.fn();
    const entrance = startAfterDocumentPaint(start, {
      fontsReady,
      requestFrame: (callback) => {
        frames.push(callback);
        return 0;
      },
      scheduleTask: (callback) => {
        tasks.push(callback);
        return 0;
      },
    });

    await Promise.resolve();
    expect(frames).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();

    fontsLoaded();
    await Promise.resolve();
    expect(frames).toHaveLength(1);

    frames.shift()?.(16);
    expect(tasks).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();

    tasks.shift()?.();
    await Promise.resolve();
    expect(frames).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();

    frames.shift()?.(1_516);
    await entrance;
    expect(start).toHaveBeenCalledOnce();
  });
});
