import { describe, expect, it, vi } from "vitest";
import { Session, type PageLike } from "../src/session.js";

function page(viewport: { width: number; height: number } | null = { width: 640, height: 480 }) {
  const click = vi.fn(async () => {});
  const waitForTimeout = vi.fn(async () => {});
  const self = {
    url: () => "https://example.test/verify",
    title: async () => "Verify",
    frames: () => [],
    context: () => ({ on: () => {}, pages: () => [self] }),
    evaluate: async () => "doc-1",
    goto: async () => undefined,
    goBack: async () => undefined,
    screenshot: async () => Buffer.alloc(0),
    innerText: async () => "",
    bringToFront: async () => {},
    waitForTimeout,
    viewportSize: () => viewport,
    mouse: { click },
  } satisfies PageLike;
  return { page: self, click, waitForTimeout };
}

describe("click_at", () => {
  it("clicks an integer point inside the current viewport and settles", async () => {
    const fake = page();

    const result = await new Session(fake.page).handle({ action: "click_at", x: 120, y: 80 });

    expect(result).toEqual({ ok: true, x: 120, y: 80 });
    expect(fake.click).toHaveBeenCalledOnce();
    expect(fake.click).toHaveBeenCalledWith(120, 80);
    expect(fake.waitForTimeout).toHaveBeenCalledWith(1000);
  });

  it.each([
    ["missing x", { y: 80 }],
    ["missing y", { x: 120 }],
    ["fractional x", { x: 1.5, y: 80 }],
    ["fractional y", { x: 120, y: 1.5 }],
    ["non-finite x", { x: Number.NaN, y: 80 }],
    ["non-finite y", { x: 120, y: Number.POSITIVE_INFINITY }],
  ])("rejects %s without clicking", async (_name, coordinates) => {
    const fake = page();

    await expect(new Session(fake.page).handle({ action: "click_at", ...coordinates }))
      .rejects.toThrow(/integer viewport coordinates/);
    expect(fake.click).not.toHaveBeenCalled();
  });

  it.each([
    ["negative x", -1, 80],
    ["negative y", 120, -1],
    ["right edge", 640, 80],
    ["bottom edge", 120, 480],
  ])("rejects %s outside the viewport without clicking", async (_name, x, y) => {
    const fake = page();

    await expect(new Session(fake.page).handle({ action: "click_at", x, y }))
      .rejects.toThrow(/outside.*640.*480/i);
    expect(fake.click).not.toHaveBeenCalled();
  });

  it("rejects a page without a viewport instead of guessing", async () => {
    const fake = page(null);

    await expect(new Session(fake.page).handle({ action: "click_at", x: 120, y: 80 }))
      .rejects.toThrow(/no viewport/i);
    expect(fake.click).not.toHaveBeenCalled();
  });
});
