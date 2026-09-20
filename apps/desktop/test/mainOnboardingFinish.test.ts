import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { compileMain, mainHandler, mainSource } from "./mainSource.js";

const compiled = compileMain(mainHandler("onboarding:finish"));

describe("finishing onboarding", () => {
  it("only hands over to the app, even if an obsolete renderer supplies a destination", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let synced = 0;
    vm.runInNewContext(compiled, {
      ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
      gate: { sync: () => { synced += 1; } },
    });

    await handlers.get("onboarding:finish")!({}, "enable-browser-and-import");
    expect(synced).toBe(1);
  });
});
