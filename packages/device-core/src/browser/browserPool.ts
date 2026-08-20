/**
 * One browser per session, instead of one browser.
 *
 * A `BrowserHost` is already a whole browser: its own server process, its own
 * profile, its own window. What made the Mac single-browser was that there was
 * exactly one of them, so a second agent had to be turned away ("browser is in
 * use by another agent") or take the first agent's browser from under it.
 *
 * This hands out one host per session id, each with its own profile directory,
 * screenshots directory and $HOME, so three agents drive three browsers that
 * cannot see each other's pages, cookies or logins. The number is capped: a
 * Camoufox is ~400 MB of RSS and a window of its own, and a Mac that quietly
 * starts twenty of them is a Mac nobody can use.
 */
import fs from "node:fs";
import path from "node:path";
import { BrowserHost, BrowserHostConfig, ViewerFrame } from "./browserHost.js";

/** Per-session directories are named from the handle, so they must be safe. */
const safe = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 36) || "session";

export interface BrowserPoolConfig extends BrowserHostConfig {
  /** How many browsers this Mac will run at once. */
  maxBrowsers?: number;
}

export const DEFAULT_MAX_BROWSERS = 3;

export class BrowserPool {
  private readonly hosts = new Map<string, BrowserHost>();
  /** The session whose browser the owner's viewer should show. */
  private mostRecent: string | null = null;

  constructor(private readonly cfg: BrowserPoolConfig) {}

  get max(): number {
    return this.cfg.maxBrowsers ?? DEFAULT_MAX_BROWSERS;
  }

  get size(): number {
    return this.hosts.size;
  }

  /** True when another browser can be started right now. */
  get hasRoom(): boolean {
    return this.hosts.size < this.max;
  }

  /**
   * The browser for this session, started on first use.
   *
   * Callers that already hold a session pass its id and always get the same
   * browser back — that is what makes a session persistent across calls.
   */
  hostFor(sessionId: string): BrowserHost {
    const existing = this.hosts.get(sessionId);
    if (existing) {
      this.mostRecent = sessionId;
      return existing;
    }
    if (!this.hasRoom) {
      throw new Error(
        `this Mac is already running ${this.max} browser${this.max === 1 ? "" : "s"} — ` +
          "close one with plow_browser_close before opening another",
      );
    }
    const dir = safe(sessionId);
    // Made here rather than left to the browser: the directory existing is
    // this pool's promise that the session has a profile of its own.
    if (this.cfg.profileDir) {
      fs.mkdirSync(path.join(this.cfg.profileDir, dir), { recursive: true, mode: 0o700 });
    }
    const host = new BrowserHost({
      ...this.cfg,
      // Each browser gets its own everything. Sharing a profile would mean
      // sharing cookies and logins between agents, which is exactly the
      // conflict this exists to prevent.
      screenshotsDir: path.join(this.cfg.screenshotsDir, dir),
      ...(this.cfg.profileDir ? { profileDir: path.join(this.cfg.profileDir, dir) } : {}),
      ...(this.cfg.isolatedHome ? { isolatedHome: path.join(this.cfg.isolatedHome, dir) } : {}),
    });
    this.hosts.set(sessionId, host);
    this.mostRecent = sessionId;
    return host;
  }

  /** The browser for a session that already has one, without starting any. */
  peek(sessionId: string): BrowserHost | null {
    return this.hosts.get(sessionId) ?? null;
  }

  /** Note which session acted last, for the owner's viewer. */
  touch(sessionId: string): void {
    if (this.hosts.has(sessionId)) this.mostRecent = sessionId;
  }

  /** Stop one session's browser and forget it, profile directory included. */
  async release(sessionId: string): Promise<void> {
    const host = this.hosts.get(sessionId);
    this.hosts.delete(sessionId);
    if (this.mostRecent === sessionId) {
      this.mostRecent = this.hosts.keys().next().value ?? null;
    }
    if (!host) return;
    try {
      await host.shutdown();
    } finally {
      host.resetBreaker();
      // The profile belonged to a session that is over; leaving it behind
      // would accumulate a browser profile per session, forever.
      if (this.cfg.profileDir) {
        fs.rmSync(path.join(this.cfg.profileDir, safe(sessionId)), { recursive: true, force: true });
      }
    }
  }

  /** Drop a session whose browser has already died. */
  forget(sessionId: string): void {
    this.hosts.delete(sessionId);
    if (this.mostRecent === sessionId) {
      this.mostRecent = this.hosts.keys().next().value ?? null;
    }
  }

  async releaseAll(): Promise<void> {
    for (const id of [...this.hosts.keys()]) await this.release(id);
  }

  /**
   * A frame for the owner's viewer: the browser of the session that acted
   * last. With several browsers running, the owner watches the one that is
   * doing something rather than an arbitrary one.
   */
  async viewFrame(): Promise<ViewerFrame | null> {
    const host = this.mostRecent ? this.hosts.get(this.mostRecent) : null;
    return host ? host.viewFrame() : null;
  }

  /** Which sessions have a browser, oldest first. */
  sessions(): string[] {
    return [...this.hosts.keys()];
  }
}
