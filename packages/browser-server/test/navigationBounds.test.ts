/** Bounded navigation actions do not spend time inspecting the page they replace. */
import { describe, expect, it } from "vitest";
import {
  NAVIGATION_TIMEOUT_MS,
  SETTLE_MS,
  Session,
  type ContextLike,
  type FrameLike,
  type PageLike,
} from "../src/session.js";

class Page implements PageLike {
  locatorCalls = 0;
  titleCalls = 0;
  broughtToFront = false;
  gotoArgs: unknown[] | null = null;
  backArgs: unknown[] | null = null;
  settles: number[] = [];
  urlValue: string;
  private ctx: ContextLike;

  constructor(url: string, pages?: Page[]) {
    this.urlValue = url;
    const pageList = pages ?? [this];
    this.ctx = { on() {}, pages: () => pageList };
  }

  setPages(pages: Page[]): void {
    this.ctx = { on() {}, pages: () => pages };
  }

  url(): string {
    return this.urlValue;
  }
  async title(): Promise<string> {
    this.titleCalls += 1;
    return "untimed title";
  }
  frames(): FrameLike[] {
    return [];
  }
  context(): ContextLike {
    return this.ctx;
  }
  async evaluate(): Promise<unknown> {
    return "doc";
  }
  locator() {
    this.locatorCalls += 1;
    return { evaluate: async () => "doc" };
  }
  async goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown> {
    this.gotoArgs = [url, opts?.timeout, opts?.waitUntil];
    this.urlValue = url;
    return undefined;
  }
  async goBack(opts?: { timeout?: number; waitUntil?: string }): Promise<unknown> {
    this.backArgs = [opts?.timeout, opts?.waitUntil];
    this.urlValue = "https://example.test/previous";
    return undefined;
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async innerText(): Promise<string> {
    return "";
  }
  async bringToFront(): Promise<void> {
    this.broughtToFront = true;
  }
  async waitForTimeout(ms: number): Promise<void> {
    this.settles.push(ms);
  }
}

describe("bounded navigation actions", () => {
  it("navigates without a document pre-check or title read", async () => {
    const page = new Page("https://example.test/start");

    await expect(new Session(page).handle({
      action: "goto",
      url: "https://example.test/next",
    })).resolves.toEqual({});

    expect(page.gotoArgs).toEqual([
      "https://example.test/next",
      NAVIGATION_TIMEOUT_MS,
      "domcontentloaded",
    ]);
    expect(page.settles).toEqual([SETTLE_MS]);
    expect(page.locatorCalls).toBe(0);
    expect(page.titleCalls).toBe(0);
  });

  it("goes back without a document pre-check or title read", async () => {
    const page = new Page("https://example.test/next");

    await expect(new Session(page).handle({ action: "back" })).resolves.toEqual({ moved: true });

    expect(page.backArgs).toEqual([NAVIGATION_TIMEOUT_MS, "domcontentloaded"]);
    expect(page.settles).toEqual([SETTLE_MS]);
    expect(page.locatorCalls).toBe(0);
    expect(page.titleCalls).toBe(0);
  });

  it("switches pages without checking or titling the abandoned page", async () => {
    const first = new Page("https://example.test/first");
    const second = new Page("https://example.test/second");
    first.setPages([first, second]);
    second.setPages([first, second]);

    await expect(new Session(first).handle({ action: "use_page", index: 1 }))
      .resolves.toEqual({ ok: true });

    expect(first.locatorCalls).toBe(0);
    expect(first.titleCalls).toBe(0);
    expect(second.broughtToFront).toBe(true);
    expect(second.titleCalls).toBe(0);
  });
});
