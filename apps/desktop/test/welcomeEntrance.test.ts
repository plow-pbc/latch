import { describe, expect, it, vi } from "vitest";
import { startAfterDocumentPaint } from "../src/renderer/welcomeEntrance.js";

async function settlePromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("the welcome entrance clock", () => {
  it("does not start while fonts or the first painted frame are stalled", async () => {
    let fontsLoaded!: () => void;
    const fontsReady = new Promise<void>((resolve) => {
      fontsLoaded = resolve;
    });
    const frames: FrameRequestCallback[] = [];
    const tasks: Array<{ callback: () => void; delay: number }> = [];
    const start = vi.fn();
    const entrance = startAfterDocumentPaint(start, {
      fontsReady,
      requestFrame: (callback) => {
        frames.push(callback);
        return 0;
      },
      scheduleTask: (callback, delay = 0) => {
        tasks.push({ callback, delay });
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
    expect(tasks.filter(({ delay }) => delay === 0)).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();

    tasks.find(({ delay }) => delay === 0)?.callback();
    await settlePromises();
    expect(frames).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();

    frames.shift()?.(1_516);
    await entrance;
    expect(start).toHaveBeenCalledOnce();
  });

  it("starts after the font wait ceiling when fonts remain pending", async () => {
    const frames: FrameRequestCallback[] = [];
    const tasks: Array<{ callback: () => void; delay: number }> = [];
    const start = vi.fn();
    const entrance = startAfterDocumentPaint(start, {
      fontsReady: new Promise(() => {}),
      requestFrame: (callback) => {
        frames.push(callback);
        return 0;
      },
      scheduleTask: (callback, delay = 0) => {
        tasks.push({ callback, delay });
        return 0;
      },
    });

    await settlePromises();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.delay).toBe(800);
    tasks.shift()?.callback();
    await settlePromises();

    frames.shift()?.(800);
    tasks.find(({ delay }) => delay === 0)?.callback();
    await settlePromises();
    frames.shift()?.(816);
    await entrance;
    expect(start).toHaveBeenCalledOnce();
  });

  it("starts when the font promise rejects without surfacing the rejection", async () => {
    const frames: FrameRequestCallback[] = [];
    const tasks: Array<{ callback: () => void; delay: number }> = [];
    const start = vi.fn();
    const entrance = startAfterDocumentPaint(start, {
      fontsReady: Promise.reject(new Error("font load failed")),
      requestFrame: (callback) => {
        frames.push(callback);
        return 0;
      },
      scheduleTask: (callback, delay = 0) => {
        tasks.push({ callback, delay });
        return 0;
      },
    });
    const settled = expect(entrance).resolves.toBeUndefined();

    await settlePromises();
    frames.shift()?.(16);
    tasks.find(({ delay }) => delay === 0)?.callback();
    await settlePromises();
    frames.shift()?.(32);

    await settled;
    expect(start).toHaveBeenCalledOnce();
  });
});
