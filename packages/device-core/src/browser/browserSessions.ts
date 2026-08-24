/**
 * Browser session store and the enforcement core.
 *
 * A session is created/widened only by an approved intent; every
 * subsequent command is validated here against the session's approved bound:
 * - navigation targets must match the origin allowlist (checked BEFORE goto);
 * - after every action the observed URL is re-checked (clicks and page JS
 *   navigate too), and popups are swept and audited;
 * - on an out-of-scope page the session is locked: nothing can be observed or
 *   interacted with except finding the way back (url/pages/use_page/goto) —
 *   recovery is a plow_browser_request intent that widens the scope;
 * - credential values flow op → here → a frame-targeted fill on an approved
 *   origin, and are dropped immediately. They never appear in the results these
 *   tools return, nor in either audit log. `eval` is the documented exception:
 *   it reads page values directly, so a filled field is readable through it.
 *
 * This layer is the cage: seatbelt cannot confine a browser (network is
 * all-or-nothing), so scope enforcement lives in trusted TS. What the origin
 * bound does NOT do: it is not network egress control — page JS (the site's
 * own, or agent-injected eval) can fetch() anywhere CORS allows. It bounds
 * what the agent observes/interacts with and where credentials get typed.
 */
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { JSONValue, jv, originMatches, normalizeOrigin } from "@domo/protocol";
import { BrowserHost, BrowserHostConfig, ViewerFrame } from "./browserHost.js";
import { CredentialBroker, CredentialError, CredentialRelease } from "./credentialBroker.js";

type AuditFn = (event: string, fields: { [k: string]: JSONValue }) => void;

interface Session {
  /** This session's own browser. One per session is the whole point. */
  host: BrowserHost;
  /** The profile directory this session holds while it lives. */
  profile: string;
  /**
   * What the audit calls this session.
   *
   * The handle is a capability now — whoever holds it can drive the browser —
   * so it must not be written to a file the owner reads, selected into an
   * agent's history, or sent to the reviewer model off this Mac. This is a
   * one-way digest of it: stable, so lines about one session can be read
   * together, and useless to anybody who reads it.
   */
  auditId: string;
  /** Closes THIS session when it goes quiet; sessions do not share a clock. */
  idleTimer: NodeJS.Timeout | null;
  /** The teardown, once one starts: everybody else waits on this one. */
  closing: Promise<void> | null;

  handle: string;
  agentId: string;
  origins: string[];
  credentialItems: Set<string>;
  lastActivity: number;
  lastUrl: string;
  knownPageCount: number;
}

/** Actions allowed while the active page is out of scope: only what an agent
 * needs to find its way back. Nothing that observes or touches page content. */
const LOCKOUT_ALLOWED = new Set(["url", "pages", "use_page", "goto"]);

/** Strip query/fragment and any userinfo for audit lines — both carry secrets. */
export function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  const cut = i === -1 ? url : url.slice(0, i);
  return cut.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1");
}

/**
 * Requests the site itself refused during an action, rebuilt from the fields
 * this side knows: origins, a status, a method, two headers. Rebuilt rather
 * than forwarded because `audit.ndjson` is durable and `server.py` is vendored
 * (see its UPSTREAM.md) — a sync that reintroduced a url would otherwise write
 * paths into the owner's log with nothing here to stop it.
 */
function failedRequests(value: JSONValue[]): JSONValue[] {
  return value.flatMap((entry) => {
    const e = jv(entry);
    if (e.obj === null) return [];
    const kept: { [k: string]: JSONValue } = {
      status: e.get("status").int ?? 0,
      method: e.get("method").str ?? "",
      origin: e.get("origin").str ?? "",
      initiator: e.get("initiator").str ?? "",
    };
    for (const header of ["retry_after", "server"]) {
      const value = e.get(header).str;
      if (value !== null) kept[header] = value;
    }
    return [kept];
  });
}

/**
 * What the AGENT is told about a refusal, and whether it is told at all.
 *
 * Both ends must be inside the approved origins: the host that refused, and the
 * document that asked. Destination alone would let a page the session is locked
 * out of fetch a url it knows will fail on an approved host and pass that off
 * as the approved page's own trouble — and an asker the browser could not name
 * goes the same way, withheld from the agent and kept for the owner. That is
 * not only the exotic case (a service worker, a request nobody saw asked): it
 * is a sub-frame's own document load, since nothing can say whether the frame
 * moved itself or its embedder moved it. The initiator itself is never handed
 * over; the agent gets the host that refused, which is the diagnosis.
 */
function forAgent(entries: JSONValue[], approved: (host: string) => boolean): JSONValue[] {
  return entries.flatMap((entry) => {
    const e = jv(entry);
    const host = hostOf(e.get("origin").str ?? "");
    const asker = hostOf(e.get("initiator").str ?? "");
    // Fail closed on an asker the browser could not name — see above for what
    // that covers, which is more than the exotic cases.
    if (host === null || asker === null) return [];
    if (!approved(host) || !approved(asker)) return [];
    const retryAfter = e.get("retry_after").str;
    const server = e.get("server").str;
    return [{
      status: e.get("status").int ?? 0,
      method: e.get("method").str ?? "",
      host,
      ...(retryAfter === null ? {} : { retry_after: retryAfter }),
      ...(server === null ? {} : { server }),
    }];
  });
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

const DEFAULT_IDLE_MS = 15 * 60_000;

/**
 * Longest a single `wait` action may park an exchange. The relay abandons a
 * tunnelled call at its own ceiling (`CLAUDE.md` § Layout owns the value) and
 * `browser` is non-deferrable, so every action must
 * answer well inside that; `wait` and `goto` are the only ones that can run
 * long by design and are bounded (here and in server.py / BrowserHost). A
 * longer pause is expressed as several waits.
 */
const MAX_WAIT_SECONDS = 12;

/**
 * Bounds on a `click`'s caller-supplied `timeout_ms`, for the same reason. The
 * ceiling is a second under the `wait` one because a click also pays the
 * server's 1 s post-click settle, and overrunning the 15 s host cap does not
 * fail the click — it tears the browser down. The floor exists because
 * Playwright reads a zero timeout as *no* timeout, so an agent asking for 0
 * would park the click until exactly that happened.
 */
const MIN_CLICK_TIMEOUT_MS = 500;
/** Exported because the agent-facing copy quotes it; one number, one source. */
export const MAX_CLICK_TIMEOUT_MS = (MAX_WAIT_SECONDS - 1) * 1000;

/** What the owner's viewer needs to know about the live session. */
export interface BrowserSessionInfo {
  origins: string[];
  agentId: string;
  /** Last URL observed after an action (query/fragment intact — local eyes only). */
  lastUrl: string;
  /** False when the active page is outside the approved origins (lockout). */
  inScope: boolean;
}

/** How many browsers this Mac will run at once. A Camoufox is a window and a
 * few hundred MB, so there is a limit and it is said out loud when it is hit. */
const DEFAULT_MAX_BROWSERS = 8;

/**
 * A short one-way name for a session.
 *
 * Used for the profile directory and for every audit line. It is a digest and
 * nothing else: the handle is a capability — whoever holds it can drive that
 * browser — so a name derived from it must not carry any of it back. Sanitising
 * the id would: it strips characters, which is both lossy (two ids folding into
 * one directory, one agent inheriting another's cookies) and revealing.
 */
const run = promisify(execFile);

const digest = (id: string): string =>
  crypto.createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16);

export class BrowserSessions {
  /** Every live session, by handle. The handle IS the browser: an agent that
   * passes the same one gets the same browser back, and two agents passing
   * different ones cannot see each other's pages. */
  private readonly sessions = new Map<string, Session>();
  /** Set once, when the app is on its way out. Nothing opens after that. */
  private quitting = false;

  constructor(
    private readonly browser: BrowserHostConfig,
    private readonly credentials: CredentialBroker | null,
    private readonly audit: AuditFn,
    private readonly idleMs: number = DEFAULT_IDLE_MS,
  ) {}

  /** True when a page URL is inside the session's approved origins.
   * Blank/initial pages have no host and are always in scope. */
  private inScope(s: Session, url: string): boolean {
    if (url === "" || url === "about:blank") return true;
    const host = hostOf(url);
    if (host === null) return true; // about:, data: — no origin to judge
    return originMatches(host, s.origins);
  }

  /** The session the owner's viewer is watching — the one that acted last. */
  current(): BrowserSessionInfo | null {
    const s = this.mostRecent();
    if (!s) return null;
    return {
      origins: [...s.origins],
      agentId: s.agentId,
      lastUrl: s.lastUrl,
      inScope: this.inScope(s, s.lastUrl),
    };
  }

  /** Open a new session (called only after an approved intent). */
  async open(
    intentId: string,
    agentId: string,
    origins: string[],
    headed?: boolean,
  ): Promise<JSONValue> {
    // The claim is made BEFORE anything is awaited. Registering after the
    // browser is warm leaves a window several seconds wide in which the map
    // says nothing is running: four concurrent opens all read a free slot and
    // four browsers start, and two opens by the same agent both take the same
    // profile directory, which Firefox then locks against itself. One record,
    // taken first, owns the capacity and the profile alike.
    // An approval can land while the app is already quitting — the intent was
    // waiting for the owner, and closeAll() has taken its snapshot. Starting a
    // browser now means one nobody will close: it and its profile outlive us.
    if (this.quitting) {
      return { status: "error", error: "this Mac is shutting down" };
    }
    if (this.sessions.size >= DEFAULT_MAX_BROWSERS) {
      return {
        status: "error",
        error:
          `this Mac is already running ${DEFAULT_MAX_BROWSERS} browsers — ` +
          "close one with plow_browser_close before opening another",
      };
    }
    const handle = crypto.randomUUID();
    // Every session browses in a directory of its own, because Firefox locks a
    // profile against a second copy of itself — but it is a CLONE of the
    // user's own profile, so every browser opens signed in wherever they are.
    // On close what it signed into is merged back into the original, and the
    // clone goes. This Mac is one person's; every browser on it is theirs.
    const profile = `session-${digest(handle)}`;
    const host = this.newHost(profile);
    // A browser that dies takes its own session with it, and nobody else's.
    host.onCrash = () => this.noteCrash(handle);
    const session: Session = {
      handle,
      host,
      profile,
      auditId: digest(handle),
      idleTimer: null,
      closing: null,
      agentId,
      origins: origins.map(normalizeOrigin),
      credentialItems: new Set(),
      lastActivity: Date.now(),
      lastUrl: "",
      knownPageCount: 1,
    };
    this.sessions.set(handle, session);

    /** Give the claim back, whatever went wrong after taking it. */
    const rollBack = async () => {
      this.sessions.delete(handle);
      try {
        await host.shutdown();
      } catch {
        /* the browser is going away regardless; the failed open is the real error */
      }
      // Thrown away, never handed back: this clone never browsed, and the
      // browser that held it is only now down.
      if (this.browser.profileDir) {
        fs.rmSync(path.join(this.browser.profileDir, profile), { recursive: true, force: true });
      }
    };

    // Warm the browser now. plow_browser_open is deferrable, so a cold Camoufox
    // start (~30s) absorbs into the deferred handle; every later `browser`
    // action is non-deferrable and must answer well inside the relay's
    // per-exchange ceiling, which it can only do against an already-running
    // browser. Failing here (no runtime, crash-looped) is an honest open error.
    try {
      await host.ensureReady(headed);
    } catch (error: unknown) {
      await rollBack();
      const message = error instanceof Error ? error.message : String(error);
      return { status: "error", error: `browser failed to start: ${message}` };
    }

    // Same order as extend(), and for the same reason: a session the owner's
    // log has no event for is a browser they cannot see being used at all.
    try {
      this.audit("browser_session_opened", {
        intentId,
        session: session.auditId,
        origins: session.origins,
        headed: host.headed,
      });
    } catch (error: unknown) {
      // A running browser with no session and no audit line is precisely the
      // invisible browser this path exists to prevent.
      await rollBack();
      throw error;
    }
    this.armIdleTimer(session);
    return {
      status: "completed",
      session: session.handle, // the capability goes back to its owner, and only there
      origins: session.origins,
      headed: host.headed,
    };
  }

  /** Widen an existing session (called only after an approved intent). */
  extend(
    intentId: string,
    handle: string,
    origins: string[],
    items: string[],
  ): JSONValue {
    const s = this.validate(handle);
    if (typeof s === "string") return { status: "error", error: s };
    // Work out the new bound without publishing it, because the record has to
    // survive before the access does. Widening the live session first and
    // auditing after means a failed append (full disk, bad permissions) leaves
    // the agent holding origins and credential items that the owner's log has
    // no event for — and the log is the only place they can see it. Recording
    // first fails the call instead, and the session keeps its old bound.
    const widened = [...s.origins];
    for (const o of origins) {
      const n = normalizeOrigin(o);
      if (!widened.includes(n)) widened.push(n);
    }
    widened.sort();
    const widenedItems = new Set(s.credentialItems);
    for (const i of items) widenedItems.add(i);
    const itemList = [...widenedItems].sort();
    this.audit("browser_session_extended", {
      intentId,
      session: s.auditId,
      origins: widened,
      items: itemList,
    });
    s.origins = widened;
    s.credentialItems = widenedItems;
    s.lastActivity = Date.now();
    return {
      status: "completed",
      origins: s.origins,
      items: itemList,
    };
  }

  /** A browser on this session's own clone of the user's profile. */
  private newHost(profile: string): BrowserHost {
    if (this.browser.profileDir) this.seedProfile(path.join(this.browser.profileDir, profile));
    return new BrowserHost({
      ...this.browser,
      screenshotsDir: path.join(this.browser.screenshotsDir, profile),
      ...(this.browser.profileDir ? { profileDir: path.join(this.browser.profileDir, profile) } : {}),
      ...(this.browser.isolatedHome ? { isolatedHome: path.join(this.browser.isolatedHome, profile) } : {}),
    });
  }

  /**
   * This session's profile: a copy of the user's own, so the browser opens
   * where they left off — signed in, with their history and their settings.
   *
   * `cp -c` is an APFS clone: a 300MB profile costs no time and no disk until
   * something writes to it. A volume that cannot clone fails the open out loud
   * rather than quietly copying 300MB per browser. The lock files never come
   * along — they belong to whichever Firefox held the profile, not to the copy.
   *
   * The user's own profile is never opened by a browser — only cloned from,
   * and merged into on close (see mergeAndRelease).
   */
  private seedProfile(dir: string): void {
    if (fs.existsSync(dir)) return;
    const seed = this.browser.seedProfile;
    if (!seed || !fs.existsSync(seed)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return;
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    execFileSync("/bin/cp", ["-Rc", seed, dir]);
    for (const lock of [".parentlock", "parent.lock", "lock"]) {
      fs.rmSync(path.join(dir, lock), { force: true });
    }
    // What this session started with, kept beside the clone. Merging back
    // needs to tell a cookie this session CHANGED from one it merely read:
    // reading moves a cookie's timestamp, and "more recent" alone would let a
    // browser that only looked at a site put its stale copy of a token over
    // the fresh one another browser was just given. Another clone, so free.
    const baseline = this.baselineOf(dir);
    const cookies = path.join(dir, "cookies.sqlite");
    if (fs.existsSync(cookies)) {
      fs.mkdirSync(baseline, { recursive: true, mode: 0o700 });
      for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(cookies + suffix)) {
          execFileSync("/bin/cp", ["-c", cookies + suffix, path.join(baseline, `cookies.sqlite${suffix}`)]);
        }
      }
    }
  }

  /** Where a session's starting cookies live: inside its own profile, which
   * Firefox ignores and which takes them with it when the session ends. */
  private baselineOf(dir: string): string {
    return path.join(dir, ".plow-baseline");
  }

  /**
   * What this session signed into, added to the user's own profile — and then
   * the clone goes.
   *
   * Merged, not handed back: replacing the profile means the last browser to
   * close decides what the user is signed into, which loses the other one's
   * login and can even undo a logout. What this session did to its cookies —
   * changes and sign-outs both — is reconciled into the profile against the
   * baseline it started from; `merge_cookies.py` holds that contract.
   *
   * ponytail: cookies only. A site that keeps its session in localStorage or
   * IndexedDB still signs out with the clone, and a logout inside a session
   * does not remove the cookie from the user's profile. Upgrade path is the
   * same merge over the other stores.
   */
  private async mergeAndRelease(s: Session): Promise<void> {
    if (!this.browser.profileDir) return;
    const dir = path.join(this.browser.profileDir, s.profile);
    try {
      await this.mergeCookies(dir);
    } catch (error: unknown) {
      // The user's profile is worth more than one merge, so it is left exactly
      // as it was — but the clone STAYS. Deleting it here would throw away the
      // one copy of whatever this session signed into, quietly, which is the
      // failure this whole change exists to prevent. It is named in the
      // owner's log, and the next thing to touch that profile can recover it.
      this.audit("browser_cookie_merge_failed", {
        session: s.auditId,
        profile: dir,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /** The merge itself: sqlite, on the interpreter this runtime already ships. */
  private async mergeCookies(dir: string): Promise<void> {
    const seed = this.browser.seedProfile;
    const from = path.join(dir, "cookies.sqlite");
    if (!seed || !fs.existsSync(from)) return;
    const into = path.join(seed, "cookies.sqlite");
    if (!fs.existsSync(into)) {
      // Nothing to merge into — a Mac whose owner has never browsed here. The
      // profile is made if it is missing: returning instead would drop this
      // session's sign-ins on exactly the machine that has none to lose them
      // among, and every session after it would do the same.
      fs.mkdirSync(seed, { recursive: true, mode: 0o700 });
      for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(from + suffix)) fs.copyFileSync(from + suffix, into + suffix);
      }
      return;
    }
    const merge = this.browser.mergeCookiesCommand;
    // Not a quiet no-op: returning here would report a merge that never
    // happened, and the clone holding the session's sign-ins would be deleted
    // on the strength of it. Failing keeps the clone and tells the owner.
    if (!merge?.length) throw new Error("this browser runtime ships no cookie merger");
    // Off the event loop: sqlite waits on a busy store, and a browser closing
    // must not stall every other call this Mac is serving.
    await run(merge[0], [...merge.slice(1), into, from, path.join(this.baselineOf(dir), "cookies.sqlite")]);
  }

  /**
   * A frame from the browser the owner is watching — the same session
   * `current()` describes, so the picture and the words underneath it are
   * always about one browser. Two places choosing separately is how a frame
   * ends up labelled with another session's origins.
   */
  async viewFrame(): Promise<ViewerFrame | null> {
    const s = this.mostRecent();
    return s ? s.host.viewFrame() : null;
  }

  /** The session that acted last — what the owner's viewer follows. */
  private mostRecent(): Session | null {
    let latest: Session | null = null;
    for (const s of this.sessions.values()) {
      // A session on its way out is listed until its profile work finishes,
      // but it is not what the owner's viewer is watching any more.
      if (s.closing) continue;
      if (!latest || s.lastActivity > latest.lastActivity) latest = s;
    }
    return latest;
  }

  /** Close a session: the handle says which browser goes. */
  async close(handle: string, reason: string): Promise<JSONValue> {
    const s = this.sessions.get(handle);
    if (!s) return { status: "error", error: "unknown session" };
    // The session stays registered across the shutdown below — the claim is
    // held until the browser is really down — so it is still reachable while
    // it is on its way out: the idle clock can come due, or a second close can
    // arrive. Either would run a whole second teardown and write the owner a
    // second "closed" line for one session. The clock is stopped and the way
    // back in is shut here, before anything is awaited.
    // Waiting on the first teardown rather than reporting a completion it has
    // not reached: the app quits on this answer, and a browser still inside
    // its shutdown would be left running with its profile on disk.
    if (s.closing) {
      await s.closing;
      return { status: "completed" };
    }
    if (s.idleTimer) clearTimeout(s.idleTimer);
    // The claim itself is held until the browser is really down. Releasing it
    // first lets the same credential reopen while Camoufox still has the
    // profile, and Firefox locks a profile against a second copy of itself.
    //
    // Only this session's browser goes away; everyone else keeps theirs, and
    // this one's profile goes with it — nothing is left for the next agent.
    // Finalized whichever way the shutdown went: a stop that throws is exactly
    // when the last thing the page said is worth having.
    const teardown = (async () => {
      try {
        await s.host.shutdown();
      } finally {
        await this.finalize(s, reason);
      }
    })();
    s.closing = teardown;
    await teardown;
    return { status: "completed" };
  }

  /**
   * A browser died under a live session. There is no host left to shut down;
   * close the books so the audit shows that session ended rather than browsing
   * forever. The circuit breaker is deliberately not reset.
   */
  noteCrash(handle: string): void {
    const s = this.sessions.get(handle);
    if (!s || s.closing) return;
    // Published the same way a close publishes its teardown: the session stays
    // in the map until the merge has settled, so a quit that arrives while a
    // crashed browser's cookies are still being written waits for them.
    s.closing = this.finalize(s, "crashed");
    void s.closing.catch(() => {
      /* the failure is already in the owner's log; nobody awaited this one */
    });
  }

  /**
   * The end of a session, in one place: the claim and the clock go, the
   * profile goes back to the user, and the owner's log says it ended.
   */
  private async finalize(s: Session, reason: string): Promise<void> {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    // The session ended when the browser did; the profile work that follows is
    // its own line in the log, so a slow merge never delays this one.
    const left = failedRequests(s.host.takeFailedRequests());
    try {
      this.audit("browser_session_closed", {
        session: s.auditId,
        reason,
        ...(left.length ? { failed_requests: left } : {}),
      });
    } finally {
      // Even when the log could not be written: the clone is still a copy of
      // the user's profile sitting on disk, and it does not get to stay there
      // because an append failed.
      try {
        await this.mergeAndRelease(s);
      } finally {
        // Listed until the very end, so a quit that snapshots the map while
        // this is running waits for it rather than leaving mid-merge.
        this.sessions.delete(s.handle);
      }
    }
  }

  /**
   * Every session goes down at once. Serially, quitting could spend one
   * browser's whole shutdown budget before the next session was even asked to
   * stop — and a quit that outruns this leaves a disposable profile, cookies
   * and all, on disk. They share nothing, so nothing here has to be ordered.
   */
  async closeAll(reason: string): Promise<void> {
    // Latched before the snapshot, so an open that resumes mid-shutdown is
    // refused rather than registering behind us.
    this.quitting = true;
    // settled, not fail-fast: one close that throws (a full disk on the audit
    // append) must not resolve this while a sibling browser is still inside
    // its shutdown timeout — the caller quits the app on this promise. The
    // failure is still raised, once everyone is really down.
    const results = await Promise.allSettled(
      [...this.sessions.values()].map((s) => this.close(s.handle, reason)),
    );
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  }

  /**
   * The session a handle names, or why there is none.
   *
   * The handle says WHICH browser, not whose: this Mac is one person's, and
   * every browser on it is theirs. Several agents run several browsers at
   * once and each passes its own handle to keep its own window.
   */
  private validate(handle: string): Session | string {
    const s = this.sessions.get(handle);
    if (!s) return "unknown session (open one with plow_browser_open)";
    // A session stays in the map while its browser shuts down. An approval
    // that lands in that window would widen — or drive — a browser already on
    // its way out, and the widening would be audited for a session that ends
    // a moment later.
    if (s.closing) return "this browser is closing";
    return s;
  }

  /** Each session closes on its own quiet, not on the busiest one's. */
  private armIdleTimer(s: Session): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (!this.sessions.has(s.handle)) return;
      if (Date.now() - s.lastActivity >= this.idleMs) {
        void this.close(s.handle, "idle");
      } else {
        this.armIdleTimer(s);
      }
    }, this.idleMs + 1000);
    s.idleTimer.unref?.();
  }

  /** Execute one agent command inside an approved session. */
  async command(handle: string, params: JSONValue): Promise<JSONValue> {
    const s = this.validate(handle);
    if (typeof s === "string") return { status: "error", error: s };
    s.lastActivity = Date.now();

    const p = jv(params);
    const action = p.get("action").str ?? "";
    // A click may be given longer than the default for a page that is still
    // settling, up to what the exchange can carry. Read here, before the
    // command runs, because the clicks worth counting later are the ones that
    // failed, and those are audited from the catch below.
    const knobs: { timeout_ms?: number } = {};
    const timeoutMs = action === "click" ? p.get("timeout_ms").num : null;
    if (timeoutMs !== null) {
      knobs.timeout_ms = Math.min(
        Math.max(timeoutMs, MIN_CLICK_TIMEOUT_MS),
        MAX_CLICK_TIMEOUT_MS,
      );
    }

    try {
      // Lockout: on an out-of-scope page, only way-back actions run.
      if (!this.inScope(s, s.lastUrl) && !LOCKOUT_ALLOWED.has(action)) {
        const origin = hostOf(s.lastUrl) ?? s.lastUrl;
        this.audit("browser_scope_violation", {
          session: s.auditId,
          action,
          origin,
        });
        return {
          status: "error",
          error:
            `page is on ${origin}, outside the approved origins ` +
            `[${s.origins.join(", ")}] — use plow_browser_request to ask for it, ` +
            `or goto an approved origin`,
        };
      }

      switch (action) {
        case "fill_secret": {
          // It builds its result by hand rather than through serverAction, and
          // its own locate/fill round-trips are where the refusals arrive.
          const filled = await this.fillSecret(
            s,
            p.get("selector").str ?? "",
            p.get("item").str ?? "",
            p.get("field").str ?? "",
          );
          const refused = this.reportRefusals(s, action, s.lastUrl, knobs, false);
          return refused.length ? { ...filled, failed_requests: refused } : filled;
        }
        case "goto": {
          const target = p.get("url").str ?? "";
          const host = hostOf(target);
          if (host === null || !originMatches(host, s.origins)) {
            this.audit("browser_scope_violation", {
              session: s.auditId,
              action: "goto",
              origin: host ?? stripQuery(target),
            });
            return {
              status: "error",
              error:
                `${host ?? target} is outside the approved origins ` +
                `[${s.origins.join(", ")}] — use plow_browser_request to widen the session`,
            };
          }
          return await this.serverAction(s, { action: "goto", url: target });
        }
        default: {
          // Pass-through actions; the server rejects unknown ones.
          const forwarded: { [k: string]: JSONValue } = { action, ...knobs };
          for (const key of ["selector", "value", "expression", "index", "direction", "seconds", "max", "frame"]) {
            const v = p.get(key).value;
            if (v !== null && v !== undefined) forwarded[key] = v;
          }
          // `wait` is agent-controlled; clamp it so a single exchange can't be
          // parked past the relay's ceiling. A longer pause is several waits.
          if (action === "wait") {
            const secs = p.get("seconds").num ?? 1;
            forwarded.seconds = Math.min(Math.max(secs, 0), MAX_WAIT_SECONDS);
          }
          return await this.serverAction(s, forwarded, knobs);
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const refused = this.reportRefusals(s, action, s.lastUrl, { ...knobs, error: message });
      return {
        status: "error",
        error: message,
        ...(refused.length ? { failed_requests: refused } : {}),
      };
    }
  }

  /**
   * Take what the browser reported, put ALL of it in the owner's log against
   * this action, and answer with what the agent may be told.
   *
   * One place, called by an action that worked and by one that threw: an action
   * fails BECAUSE its request was refused at least as often as for any other
   * reason, and a report only the success path makes is missing exactly then.
   */
  private reportRefusals(
    s: Session,
    action: string,
    url: string,
    extra: { [k: string]: JSONValue },
    // fill_secret writes its own credential_* line for every outcome that
    // reaches the browser, so it asks for a browser_command line only when
    // there is a refusal to put on one.
    alwaysAudit = true,
  ): JSONValue[] {
    const failed = failedRequests(s.host.takeFailedRequests());
    if (!alwaysAudit && failed.length === 0) return [];
    this.audit("browser_command", {
      session: s.auditId,
      action,
      url: stripQuery(url),
      ...extra,
      ...(failed.length ? { failed_requests: failed } : {}),
    });
    return forAgent(failed, (host) => originMatches(host, s.origins));
  }

  /** Send to the server, then observe where we landed and sweep popups. */
  private async serverAction(
    s: Session,
    action: { [k: string]: JSONValue },
    knobs: { [k: string]: JSONValue } = {},
  ): Promise<JSONValue> {
    const result = await s.host.sendAction(action);
    const url = typeof result.url === "string" ? result.url : "";
    const pageCount = typeof result.page_count === "number" ? result.page_count : 1;

    const navigated = url !== s.lastUrl;
    s.lastUrl = url;
    if (navigated) {
      this.audit("browser_navigated", { session: s.auditId, url: stripQuery(url) });
    }
    if (pageCount !== s.knownPageCount) {
      s.knownPageCount = pageCount;
      await this.sweepPages(s);
    }
    // `knobs` is what the agent had to ask for, so the next look at a session
    // that went wrong can count it the way this one counted `eval`.
    const refused = this.reportRefusals(s, String(action.action), url, knobs);

    // The browser puts the mark back on every concealed field before it lets
    // anything be observed, and says so when one of them would not take. It
    // sends no picture and no field list in that case, and neither does this:
    // an observation that cannot be made safely is not made.
    if (result.ok === false && result.mask === "unmasked") {
      this.audit("credential_mask_failed", {
        session: s.auditId,
        action: String(action.action),
        url: stripQuery(url),
      });
      return {
        status: "error",
        error:
          `${String(action.action)} was refused: a field on this page holds a value the vault ` +
          `conceals and the page will not let it be hidden on screen. Navigate away from it, ` +
          `or fill that field by hand.`,
        // Already out of the host, so nothing else will carry them.
        ...(refused.length ? { failed_requests: refused } : {}),
      };
    }

    const out: { [k: string]: JSONValue } = { status: "completed", ...result };
    if (refused.length) out.failed_requests = refused;
    // If the action itself landed us out of scope, say so in the result — the
    // agent should learn immediately, not on its next refused command.
    if (!this.inScope(s, url)) {
      const origin = hostOf(url) ?? url;
      this.audit("browser_scope_violation", {
        session: s.auditId,
        action: String(action.action),
        origin,
      });
      out.out_of_scope = origin;
      out.note =
        `landed on ${origin}, outside the approved origins — page content is ` +
        `locked; use plow_browser_request to ask for this origin`;
      // Never hand out content from an unapproved origin.
      delete out.data_b64;
      delete out.text;
      delete out.result;
      delete out.links;
      delete out.forms;
      delete out.tables;
      delete out.title;
    }
    return out;
  }

  private async sweepPages(s: Session): Promise<void> {
    try {
      const pages = await s.host.sendAction({ action: "pages" });
      const list = Array.isArray(pages.pages) ? pages.pages : [];
      for (const pg of list) {
        const url = jv(pg).get("url").str ?? "";
        this.audit("browser_navigated", {
          session: s.auditId,
          url: stripQuery(url),
          page_index: jv(pg).get("i").int ?? -1,
        });
      }
    } catch {
      /* sweep is best-effort; the per-action check still guards content */
    }
  }

  /**
   * The strongest gate. Order matters: approved item → locate the frame the
   * selector is actually in → that frame's origin must be approved → ask the
   * vault whether it masks this field → the op broker releases against the
   * DEVICE-observed frame URL (its own item-origin check applies) →
   * frame-targeted fill, marking the element when the vault masks it → value
   * dropped.
   *
   * The mask question is asked before the secret is fetched, so nothing is
   * holding a value while a second broker process runs.
   */
  private async fillSecret(
    s: Session,
    selector: string,
    itemId: string,
    field: string,
  ): Promise<{ [k: string]: JSONValue }> {
    if (!this.credentials) return { status: "error", error: "credential broker not available" };
    if (selector === "" || itemId === "" || field === "") {
      return { status: "error", error: "fill_secret requires selector, item, field" };
    }
    if (!s.credentialItems.has(itemId)) {
      this.audit("credential_denied", {
        session: s.auditId,
        item: itemId,
        field,
        origin: hostOf(s.lastUrl) ?? "",
        reason: "item not approved for this session",
      });
      return {
        status: "error",
        error: `item ${itemId} is not approved for this session — use plow_browser_request with credential_items`,
      };
    }

    const located = await s.host.sendAction({ action: "locate", selector });
    const frame = typeof located.frame === "number" ? located.frame : 0;
    const frameUrl = typeof located.frame_url === "string" ? located.frame_url : "";
    // What identifies the document this field is in. The url answers "may a
    // credential go here"; this answers "is this still the same page", which a
    // url cannot — an SPA rewrites it without replacing anything.
    const frameToken = typeof located.frame_token === "string" ? located.frame_token : null;
    const frameHost = hostOf(frameUrl);
    if (frameHost === null || !originMatches(frameHost, s.origins)) {
      this.audit("credential_denied", {
        session: s.auditId,
        item: itemId,
        field,
        origin: frameHost ?? stripQuery(frameUrl),
        reason: "frame origin outside session scope",
      });
      return {
        status: "error",
        error: `the field is in a frame on ${frameHost ?? frameUrl}, outside the approved origins`,
      };
    }

    // The value and whether the vault conceals it come back together, from one
    // reading of the item. Two questions would be two answers about two moments
    // — and an item edited between them releases a concealed value under the
    // flag the old one carried.
    let release: CredentialRelease;
    try {
      release = await this.credentials.getField(itemId, field, frameUrl);
    } catch (error: unknown) {
      const type = error instanceof CredentialError ? error.type : "BrokerFailed";
      const message = error instanceof Error ? error.message : String(error);
      this.audit("credential_denied", {
        session: s.auditId,
        item: itemId,
        field,
        origin: frameHost,
        reason: `${type}: ${message}`,
      });
      // A field the vault will not offer is answered in this device's own
      // words; anything else keeps the broker's, which is written for a human
      // and carries no value.
      if (type === "InvalidArgument") {
        return {
          status: "error",
          error:
            `item ${itemId} does not offer a field called ${field} — ask ` +
            `plow_vault {action: "describe"} for the item and use one it lists`,
        };
      }
      return { status: "error", error: `credential release refused: ${message}` };
    }
    // Asking the vault takes long enough for the session to end underneath
    // this: closed by the owner, by the idle timer, or by a crash. Its browser
    // goes with it, and the next session to be handed that handle would be a
    // different browser — so a value released for a session that no longer
    // exists must not be typed into anything.
    if (this.sessions.get(s.handle) !== s) {
      this.audit("credential_denied", {
        session: s.auditId,
        item: itemId,
        field,
        origin: frameHost,
        selector,
        reason: "the session ended while the vault was being asked",
      });
      return {
        status: "error",
        error:
          `${field} was not filled: this browser session ended while the vault was being asked ` +
          `for the value, so nothing was typed. Open a session and try again.`,
      };
    }

    const mask = release.hidden;
    let secret = release.value;

    try {
      const filled = await s.host.sendAction({
        action: "fill",
        selector,
        value: secret,
        frame,
        // The origin was checked against this document before the vault was
        // asked for the value. A frame index is not an identity — the site can
        // swap the iframe out while that is in flight — so the browser is told
        // which document was approved and refuses if the node is in another.
        ...(frameToken === null ? {} : { frame_token: frameToken }),
        // Only a masked field carries the mark; a visible one — an address, a
        // username, a cardholder name — is filled exactly as it always was,
        // with nothing added to the page.
        ...(mask ? { mask: true } : {}),
      });
      // The browser reports back whether the mark actually took. A page can
      // defeat it — a Content-Security-Policy without 'unsafe-inline' in
      // style-src blocks the stylesheet the mask rides on — and when it does,
      // nothing was typed: the value would have been legible in every
      // screenshot from that moment on, which is the whole thing this exists to
      // prevent. Refused rather than filled.
      if (filled.mask === "moved") {
        this.audit("credential_denied", {
          session: s.auditId,
          item: itemId,
          field,
          origin: frameHost,
          selector,
          reason: "the frame was replaced after its origin was approved",
        });
        return {
          status: "error",
          error:
            `${field} was not filled: the frame holding ${selector} was replaced while the vault ` +
            `was being asked for the value, so it is no longer the one whose origin was approved. ` +
            `Screenshot the page and locate the field again.`,
        };
      }
      if (filled.ok !== true) {
        this.audit("credential_denied", {
          session: s.auditId,
          item: itemId,
          field,
          origin: frameHost,
          selector,
          reason: "the page prevented the value from being masked",
        });
        return {
          status: "error",
          error:
            `${field} was not filled: this page stops the value from being hidden on screen, ` +
            `so it was not typed. Fill it by hand, or use a field the vault does not conceal.`,
        };
      }
    } catch (error: unknown) {
      // Playwright reports what it tried to type: `filling "hunter2"` is part of
      // its failure message. Forwarding that hands the agent the very value this
      // whole path exists to keep from it — and a wrong selector, a hidden field
      // or a slow render is the common case, not an exotic one. So the error the
      // agent sees is written here, never forwarded, and the audit copy is
      // scrubbed too: the secret is toxic everywhere, not only in model context.
      // The reason is written here too, not scrubbed from the browser's text:
      // that text is truncated to MAX_ERROR_LEN before it reaches us, so a long
      // enough secret loses its tail and an exact-match scrub leaves the prefix
      // behind in audit.ndjson. Nothing derived from the failure text is kept.
      this.audit("credential_fill_failed", {
        session: s.auditId,
        item: itemId,
        field,
        origin: frameHost,
        selector,
        reason: "the browser could not type it into that field",
      });
      return {
        status: "error",
        error:
          `could not type ${field} into ${selector} — the field may be the wrong one, ` +
          `hidden, or not ready yet. Screenshot the page and check the selector.`,
      };
    } finally {
      secret = "";
    }
    this.audit("credential_filled", {
      session: s.auditId,
      item: itemId,
      field,
      origin: frameHost,
    });
    return { status: "completed", ok: true, frame };
  }
}
