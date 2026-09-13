/**
 * A screenshot is handed back inline and lands nowhere else. It used to also
 * be written under a per-session directory that nothing read and nothing
 * cleaned, so every page an agent ever looked at stayed on the Mac.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session, type PageLike } from "../src/session.js";

function page(shot: Buffer, screenshot = vi.fn(async () => shot)): PageLike {
  const self: PageLike = {
    mouse: { click: async () => {} },
    url: () => "https://example.test/",
    title: async () => "Example",
    frames: () => [],
    context: () => ({ on: () => {}, pages: () => [self] }),
    evaluate: async () => undefined,
    goto: async () => undefined,
    goBack: async () => undefined,
    screenshot,
    innerText: async () => "",
    bringToFront: async () => {},
    waitForTimeout: async () => {},
    viewportSize: () => ({ width: 640, height: 480 }),
  };
  return self;
}

describe("screenshot", () => {
  it("returns the image inline and writes no file", async () => {
    const cwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-shot-"));
    process.chdir(dir);
    try {
      const shot = Buffer.from("not-really-a-jpeg");
      const result = await new Session(page(shot)).handle({ action: "screenshot" });
      expect(result).toEqual({ data_b64: shot.toString("base64"), mime: "image/jpeg" });
      expect(result).not.toHaveProperty("path");
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an image whose pixels use the viewport coordinate scale", async () => {
    const screenshot = vi.fn(async () => Buffer.from("not-really-a-jpeg"));

    await new Session(page(Buffer.alloc(0), screenshot)).handle({ action: "screenshot" });

    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ scale: "css" }));
  });
});
