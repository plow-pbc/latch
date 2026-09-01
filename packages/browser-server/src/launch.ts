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
  /** The VALID entry the pin names, or undefined when the pin is absent, corrupt,
   * or names an id no longer in the pool (e.g. after a browser bump regenerated
   * the pool with fresh ids). */
  const readValid = (): FingerprintEntry | undefined => {
    try {
      const { id } = JSON.parse(fs.readFileSync(pinPath!, "utf8")) as { id?: string };
      return id ? byId.get(id) : undefined;
    } catch {
      return undefined;
    }
  };
  if (!pinPath) return pool.entries[crypto.randomInt(pool.entries.length)];

  const existing = readValid();
  if (existing) return existing;

  // No valid pin. Choose one and publish it.
  fs.mkdirSync(path.dirname(pinPath), { recursive: true });
  const chosen = pool.entries[crypto.randomInt(pool.entries.length)];
  try {
    // Absent file: exclusive create, so simultaneous FIRST launches converge —
    // the loser gets EEXIST and adopts the winner's valid pin (via the repair
    // path below, which returns the valid pin without touching it).
    fs.writeFileSync(pinPath, JSON.stringify({ id: chosen.id }), { flag: "wx", mode: 0o600 });
    return chosen;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return chosen; // unwritable
  }
  // The file exists. Either a concurrent launch just wrote a VALID pin (adopt
  // it), or the pin is STALE/CORRUPT and must be repaired — otherwise every
  // launch re-randomizes and never converges. Elect ONE repairer under a lock so
  // every concurrent caller returns the SAME id: an atomic rename alone converges
  // the FILE, but lets an in-flight launch return its own pick before another's
  // rename lands (40 concurrent repairs otherwise yielded several fingerprints).
  return repairPin(pinPath, chosen, readValid);
}

/** Block this thread briefly. pinnedEntry is synchronous and runs ONCE per
 * launch in a dedicated process that is about to block on browser startup, so a
 * bounded busy-wait during the rare repair race is fine. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer disabled — skip the wait; still correct, just spins */
  }
}

/** Repair a stale/corrupt pin under a lock so concurrent repairers all adopt one
 * pick. The winner of an exclusive-create on `<pin>.lock` writes the pin; the
 * losers wait and read the winner's id. A lock a crashed repairer left is
 * reclaimed after a timeout, so the mechanism self-heals. */
function repairPin(
  pinPath: string,
  chosen: FingerprintEntry,
  readValid: () => FingerprintEntry | undefined,
): FingerprintEntry {
  const lock = `${pinPath}.lock`;
  const stealAfter = Date.now() + 2000;
  for (;;) {
    const valid = readValid();
    if (valid) return valid; // the winner already published — adopt it
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return chosen; // cannot lock
      // Another process holds the lock. Wait, then retry — adopting its pin, or
      // reclaiming the lock if it looks abandoned.
      if (Date.now() > stealAfter) {
        try {
          fs.unlinkSync(lock);
        } catch {
          /* someone else reclaimed it first */
        }
      }
      sleepSync(15);
      continue;
    }
    // We hold the lock: repair once, unless a prior holder already did.
    try {
      const again = readValid();
      if (again) return again;
      const tmp = `${pinPath}.${process.pid}.${crypto.randomInt(1_000_000_000)}`;
      fs.writeFileSync(tmp, JSON.stringify({ id: chosen.id }), { mode: 0o600 });
      fs.renameSync(tmp, pinPath);
      return chosen;
    } finally {
      try {
        fs.unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  }
}

/** The browser build a pool was generated for, comparable to Playwright's
 * `browser.version()`: `runtime.lock.json` names it "official/152.0.4-beta.28",
 * playwright reports "152.0.4-beta.28", so drop the repo prefix. */
export function poolBrowserBuild(poolVersion: string): string {
  return poolVersion.split("/").pop() ?? poolVersion;
}

/** Whether a pool may drive a browser reporting `version`. Unknown (empty)
 * versions are permitted — refusing on a version we could not read would be a
 * worse failure than the mismatch it guards against. */
export function poolMatchesBrowser(pool: FingerprintPool, version: string): boolean {
  if (!version) return true;
  return poolBrowserBuild(pool.browserVersion) === version;
}

/** Launch the browser and hand back its first page. Camoufox yields a Browser
 * normally and a BrowserContext when persistent; a persistent context arrives
 * with a page ALREADY open, so we take pages()[0] there rather than opening a
 * second the owner cannot tell apart.
 *
 * The pool's configs were validated (at generation time) against ONE browser
 * build, so a stale pool or an overridden binary is refused rather than run with
 * fingerprint data meant for a different version. */
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

  const context = opts.profileDir
    ? await firefox.launchPersistentContext(opts.profileDir, common)
    : null;
  const browser = context ? context.browser() : await firefox.launch(common);
  const close = context ? (): Promise<void> => context.close() : (): Promise<void> => browser!.close();
  const version = browserVersionOf(browser);

  if (!poolMatchesBrowser(pool, version)) {
    await close();
    throw new Error(
      `fingerprint pool is for browser ${poolBrowserBuild(pool.browserVersion)} but launched ` +
        `${version}; regenerate the pool (just fetch-browser) or fix DOMO_CAMOUFOX`,
    );
  }

  const page = (
    context ? (context.pages()[0] ?? (await context.newPage())) : await browser!.newPage()
  ) as unknown as PageLike;
  return { page, version, close };
}

function browserVersionOf(browser: { version(): string } | null): string {
  try {
    return browser?.version() ?? "";
  } catch {
    return "";
  }
}
