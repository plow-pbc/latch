/**
 * A screenshot is handed back inline and lands nowhere else. It used to also
 * be written under a per-session directory that nothing read and nothing
 * cleaned, so every page an agent ever looked at stayed on the Mac.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session, type PageLike } from "../src/session.js";

function page(shot: Buffer): PageLike {
  const self: PageLike = {
    url: () => "https://example.test/",
    title: async () => "Example",
    frames: () => [],
    context: () => ({ on: () => {}, pages: () => [self] }),
    evaluate: async () => undefined,
    locator: () => ({ evaluate: async () => undefined }),
    goto: async () => undefined,
    goBack: async () => undefined,
    screenshot: async () => shot,
    innerText: async () => "",
    bringToFront: async () => {},
    waitForTimeout: async () => {},
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
});
