/**
 * Launching the pinned Camoufox browser from a build-time fingerprint pool.
 *
 * The old server.py generated a fresh Camoufox fingerprint on every launch via
 * the Python `camoufox` package. We ship no Python and no fingerprint generator:
 * `scripts/build-browser-runtime.mjs` samples a POOL of macOS launch configs at
 * BUILD time (using camoufox-js, a build-only dependency) and freezes them as
 * `fingerprints.json` in the runtime. Here we pick ONE and drive the browser
 * with plain `playwright-core`.
 *
 * The pick is PINNED PER INSTALL, not random per launch: a persistent browser
 * that carries the owner's real profile and logins wants a STABLE Mac
 * fingerprint — a device whose screen size or GPU changes between sessions is a
 * bot signal, not a defense (DESIGN.md §11a). BrowserHost points
 * DOMO_FINGERPRINT_PIN at a per-install path; the first launch picks an entry
 * and records it there, every later launch reuses it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { firefox } from "playwright-core";
import type { PageLike } from "./session.js";

/** One frozen launch config: everything `firefox.launch` needs except the
 * executable path and window mode, which are runtime facts. Whatever keys
 * camoufox-js's launchOptions sets (env with CAMOU_CONFIG chunks,
 * firefoxUserPrefs, args) ride along untouched. */
export interface FingerprintEntry {
  id: string;
  env?: Record<string, string>;
  firefoxUserPrefs?: Record<string, string | number | boolean>;
  args?: string[];
}

export interface FingerprintPool {
  /** The browser build these were sampled against — a mismatch is refused so a
   * stale pool never launches a browser it was not generated for. */
  browserVersion: string;
  entries: FingerprintEntry[];
}

export interface LaunchOptions {
  /** Camoufox executable (the app's --executable). */
  executablePath: string;
  /** Directory holding fingerprints.json (the server dir). */
  poolDir: string;
  headed: boolean;
  /** Persistent profile dir; undefined for an ephemeral context. */
  profileDir?: string;
  /** Where the per-install pin is stored (DOMO_FINGERPRINT_PIN). Undefined
   * falls back to a random pick per launch — dev only. */
  pinPath?: string;
}

/** A live browser + its first page. Structural so tests need no real browser. */
export interface LaunchedBrowser {
  page: PageLike;
  version: string;
  close(): Promise<void>;
}

export function loadPool(poolDir: string): FingerprintPool {
  const file = path.join(poolDir, "fingerprints.json");
  const pool = JSON.parse(fs.readFileSync(file, "utf8")) as FingerprintPool;
  if (!Array.isArray(pool.entries) || pool.entries.length === 0) {
    throw new Error(`fingerprint pool ${file} is empty`);
  }
  return pool;
}

/**
 * The entry pinned for this install. Reads the id recorded at `pinPath`; if none
 * is recorded (or it names an entry no longer in the pool — a pool regenerated
 * on a browser bump), picks one at random and records it. With no pinPath the
 * pick is per launch, for dev runs that do not care about stability.
 */
export function pinnedEntry(pool: FingerprintPool, pinPath?: string): FingerprintEntry {
  const byId = new Map(pool.entries.map((e) => [e.id, e]));
  if (pinPath) {
    try {
      const pinned = JSON.parse(fs.readFileSync(pinPath, "utf8")) as { id?: string };
      const hit = pinned.id ? byId.get(pinned.id) : undefined;
      if (hit) return hit;
    } catch {
      /* absent or unreadable — fall through and pick one */
    }
  }
  const chosen = pool.entries[crypto.randomInt(pool.entries.length)];
  if (pinPath) {
    try {
      fs.mkdirSync(path.dirname(pinPath), { recursive: true });
      fs.writeFileSync(pinPath, JSON.stringify({ id: chosen.id }), { mode: 0o600 });
    } catch {
      /* best effort: an unrecordable pin just re-picks next launch */
    }
  }
  return chosen;
}

/** Launch the browser and hand back its first page. Camoufox yields a Browser
 * normally and a BrowserContext when persistent; a persistent context arrives
 * with a page ALREADY open, so we take pages()[0] there rather than opening a
 * second the owner cannot tell apart. */
export async function launchBrowser(opts: LaunchOptions): Promise<LaunchedBrowser> {
  const pool = loadPool(opts.poolDir);
  const entry = pinnedEntry(pool, opts.pinPath);
  const common = {
    executablePath: opts.executablePath,
    headless: !opts.headed,
    args: entry.args ?? [],
    env: { ...process.env, ...(entry.env ?? {}) } as Record<string, string>,
    firefoxUserPrefs: entry.firefoxUserPrefs,
  };

  if (opts.profileDir) {
    const context = await firefox.launchPersistentContext(opts.profileDir, common);
    const page = (context.pages()[0] ?? (await context.newPage())) as unknown as PageLike;
    const version = browserVersionOf(context.browser());
    return { page, version, close: () => context.close() };
  }
  const browser = await firefox.launch(common);
  const page = (await browser.newPage()) as unknown as PageLike;
  return { page, version: browserVersionOf(browser), close: () => browser.close() };
}

function browserVersionOf(browser: { version(): string } | null): string {
  try {
    return browser?.version() ?? "";
  } catch {
    return "";
  }
}
