/**
 * Browser session store and the enforcement core.
 *
 * A session is created/widened only by an approved signed intent; every
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
import fs from "node:fs";
import path from "node:path";
import { JSONValue, jv, originMatches, normalizeOrigin } from "@domo/protocol";
import { BrowserHost, BrowserHostConfig, ViewerFrame } from "./browserHost.js";
import { CredentialBroker, CredentialError, CredentialRelease } from "./credentialBroker.js";

type AuditFn = (event: string, fields: { [k: string]: JSONValue }) => void;

interface Session {
  /** This session's own browser. One per session is the whole point. */
  host: BrowserHost;
  /** Closes THIS session when it goes quiet; sessions do not share a clock. */
  idleTimer: NodeJS.Timeout | null;

  handle: string;
  agentId: string;
  origins: string[];
  credentialMetadata: boolean;
  credentialItems: Set<string>;
  lastActivity: number;
  lastUrl: string;
  knownPageCount: number;
}

/** Actions allowed while the active page is out of scope: only what an agent
 * needs to find its way back. Nothing that observes or touches page content. */
const LOCKOUT_ALLOWED = new Set(["url", "pages", "use_page", "goto"]);

/** Strip query/fragment for audit lines — they carry tokens. */
export function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i === -1 ? url : url.slice(0, i);
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
 * tunnelled call at ~20s and `browser` is non-deferrable, so every action must
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
 * few hundred MB, so the number is small and the limit is said out loud. */
export const DEFAULT_MAX_BROWSERS = 3;

/**
 * The directory name for an agent's profile.
 *
 * Sanitising the id was not enough: stripping characters is lossy, so "a/b"
 * and "ab" both became "ab" — two different agents sharing one profile, which
 * is one agent inheriting the other's cookies and signed-in sessions. The
 * name ends in a hash of the WHOLE id, so two ids can only collide if SHA-256
 * does. The readable half is there for whoever reads the directory listing and
 * carries no meaning.
 */
const profileName = (id: string): string => {
  const readable = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
  const digest = crypto.createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16);
  return readable ? `${readable}-${digest}` : digest;
};

export class BrowserSessions {
  /** Every live session, by handle. The handle IS the browser: an agent that
   * passes the same one gets the same browser back, and two agents passing
   * different ones cannot see each other's pages. */
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly browser: BrowserHostConfig & { maxBrowsers?: number },
    private readonly credentials: CredentialBroker | null,
    private readonly audit: AuditFn,
    private readonly idleMs: number = DEFAULT_IDLE_MS,
  ) {}

  /** How many browsers are open right now. */
  get count(): number {
    return this.sessions.size;
  }

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
    credentialMetadata: boolean,
    headed?: boolean,
  ): Promise<JSONValue> {
    // Nothing is taken from anybody: this session gets a browser of its own,
    // and other agents keep theirs. The only limit is how many browsers this
    // Mac will run at once, and that is said out loud rather than by evicting
    // whoever was here first.
    const max = this.browser.maxBrowsers ?? DEFAULT_MAX_BROWSERS;
    if (this.sessions.size >= max) {
      return {
        status: "error",
        error:
          `this Mac is already running ${max} browser${max === 1 ? "" : "s"} — ` +
          "close one with plow_browser_close before opening another",
      };
    }
    const handle = crypto.randomUUID();
    const host = this.newHost(agentId);

    // A browser that dies takes its own session with it, and nobody else's.
    host.onCrash = () => this.noteCrash(handle);

    // Warm the browser now. plow_browser_open is deferrable, so a cold Camoufox
    // start (~30s) absorbs into the deferred handle; every later `browser`
    // action is non-deferrable and must answer well inside the relay's ~20s
    // per-exchange ceiling, which it can only do against an already-running
    // browser. Failing here (no runtime, crash-looped) is an honest open error.
    try {
      await host.ensureReady(headed);
    } catch (error: unknown) {
      await this.stop(host);
      const message = error instanceof Error ? error.message : String(error);
      return { status: "error", error: `browser failed to start: ${message}` };
    }

    const session: Session = {
      handle,
      host,
      idleTimer: null,
      agentId,
      origins: origins.map(normalizeOrigin),
      credentialMetadata,
      credentialItems: new Set(),
      lastActivity: Date.now(),
      lastUrl: "",
      knownPageCount: 1,
    };
    // Same order as extend(), and for the same reason: a session the owner's
    // log has no event for is a browser they cannot see being used at all.
    try {
      this.audit("browser_session_opened", {
        intentId,
        session: session.handle,
        origins: session.origins,
        credential_metadata: credentialMetadata,
        headed: host.headed,
      });
    } catch (error: unknown) {
      // The browser is already warm — ensureReady ran above, and headed means a
      // window is on screen. If the opening cannot be recorded there is no
      // session to close it later, so put it away here: a running browser with
      // no session and no audit line is precisely the invisible browser this
      // path exists to prevent.
      try {
        await this.stop(host);
      } catch {
        /* the browser is going away regardless; the failed open is the real error */
      }
      throw error;
    }
    this.sessions.set(session.handle, session);
    this.armIdleTimer(session);
    return {
      status: "completed",
      session: session.handle,
      origins: session.origins,
      headed: host.headed,
    };
  }

  /** Widen an existing session (called only after an approved intent). */
  extend(
    intentId: string,
    agentId: string,
    handle: string,
    origins: string[],
    items: string[],
    credentialMetadata: boolean,
  ): JSONValue {
    const s = this.validate(agentId, handle);
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
      session: s.handle,
      origins: widened,
      items: itemList,
    });
    s.origins = widened;
    s.credentialItems = widenedItems;
    if (credentialMetadata) s.credentialMetadata = true;
    s.lastActivity = Date.now();
    return {
      status: "completed",
      session: s.handle,
      origins: s.origins,
      items: itemList,
    };
  }

  /**
   * A browser for this agent.
   *
   * The profile is keyed to the AGENT, not to the session: an agent that opens,
   * signs into a site, closes, and opens again tomorrow is still signed in —
   * which is what the tool has always promised. Two agents never share one,
   * so neither can see the other's cookies. Everything else (screenshots, the
   * app-scoped $HOME) is per agent for the same reason.
   */
  private newHost(agentId: string): BrowserHost {
    const dir = profileName(agentId);
    if (this.browser.profileDir) fs.mkdirSync(path.join(this.browser.profileDir, dir), { recursive: true, mode: 0o700 });
    return new BrowserHost({
      ...this.browser,
      screenshotsDir: path.join(this.browser.screenshotsDir, dir),
      ...(this.browser.profileDir ? { profileDir: path.join(this.browser.profileDir, dir) } : {}),
      ...(this.browser.isolatedHome ? { isolatedHome: path.join(this.browser.isolatedHome, dir) } : {}),
    });
  }

  /**
   * Stop one browser and clear its shutdown latch — one operation, never two.
   * `shutdown()` sets `shuttingDown` and only `resetBreaker()` clears it, so a
   * split pair can leave a host that starts, publishes a session, and then
   * fails every command at the `sendAction()` guard.
   */
  private async stop(host: BrowserHost): Promise<void> {
    try {
      await host.shutdown();
    } finally {
      host.resetBreaker();
    }
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
      if (!latest || s.lastActivity > latest.lastActivity) latest = s;
    }
    return latest;
  }

  /**
   * Close a session. `agentId` is checked when given: a handle is a capability,
   * and an agent holding somebody else's handle must not be able to shut their
   * browser. The owner's own paths (idle, shutdown) pass no agent.
   */
  async close(handle: string, reason: string, agentId?: string): Promise<JSONValue> {
    const s = this.sessions.get(handle);
    if (!s) return { status: "error", error: "unknown session" };
    if (agentId !== undefined && s.agentId !== agentId) {
      return { status: "error", error: "session belongs to a different agent" };
    }
    this.sessions.delete(handle);
    if (s.idleTimer) clearTimeout(s.idleTimer);
    // Only this session's browser goes away; everyone else keeps theirs. The
    // profile stays: it belongs to the agent, not to this session, which is
    // what "your profile persists between sessions" means.
    await this.stop(s.host);
    this.audit("browser_session_closed", { session: handle, reason });
    return { status: "completed" };
  }

  /**
   * A browser died under a live session. There is no host left to shut down;
   * close the books so the audit shows that session ended rather than browsing
   * forever. The circuit breaker is deliberately not reset.
   */
  noteCrash(handle: string): void {
    const s = this.sessions.get(handle);
    if (!s) return;
    this.sessions.delete(handle);
    if (s.idleTimer) clearTimeout(s.idleTimer);
    this.audit("browser_session_closed", { session: s.handle, reason: "crashed" });
  }

  async closeAll(reason: string): Promise<void> {
    for (const s of [...this.sessions.values()]) await this.close(s.handle, reason);
  }

  private validate(agentId: string, handle: string): Session | string {
    const s = this.sessions.get(handle);
    if (!s) return "unknown session (open one with plow_browser_open)";
    if (s.agentId !== agentId) return "session belongs to a different agent";
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
  async command(agentId: string, handle: string, params: JSONValue): Promise<JSONValue> {
    const s = this.validate(agentId, handle);
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
          session: s.handle,
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
        case "fill_secret":
          return await this.fillSecret(
            s,
            p.get("selector").str ?? "",
            p.get("item").str ?? "",
            p.get("field").str ?? "",
          );
        case "goto": {
          const target = p.get("url").str ?? "";
          const host = hostOf(target);
          if (host === null || !originMatches(host, s.origins)) {
            this.audit("browser_scope_violation", {
              session: s.handle,
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
      this.audit("browser_command", {
        session: s.handle,
        action,
        url: stripQuery(s.lastUrl),
        ...knobs,
        error: message,
      });
      return { status: "error", error: message };
    }
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
      this.audit("browser_navigated", { session: s.handle, url: stripQuery(url) });
    }
    if (pageCount !== s.knownPageCount) {
      s.knownPageCount = pageCount;
      await this.sweepPages(s);
    }
    this.audit("browser_command", {
      session: s.handle,
      action: String(action.action),
      url: stripQuery(url),
      // What the agent had to ask for, so the next look at a session that went
      // wrong can count it the way this one counted `eval`.
      ...knobs,
    });

    // The browser puts the mark back on every concealed field before it lets
    // anything be observed, and says so when one of them would not take. It
    // sends no picture and no field list in that case, and neither does this:
    // an observation that cannot be made safely is not made.
    if (result.ok === false && result.mask === "unmasked") {
      this.audit("credential_mask_failed", {
        session: s.handle,
        action: String(action.action),
        url: stripQuery(url),
      });
      return {
        status: "error",
        error:
          `${String(action.action)} was refused: a field on this page holds a value the vault ` +
          `conceals and the page will not let it be hidden on screen. Navigate away from it, ` +
          `or fill that field by hand.`,
      };
    }

    const out: { [k: string]: JSONValue } = { status: "completed", ...result };
    // If the action itself landed us out of scope, say so in the result — the
    // agent should learn immediately, not on its next refused command.
    if (!this.inScope(s, url)) {
      const origin = hostOf(url) ?? url;
      this.audit("browser_scope_violation", {
        session: s.handle,
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
          session: s.handle,
          url: stripQuery(url),
          page_index: jv(pg).get("i").int ?? -1,
        });
      }
    } catch {
      /* sweep is best-effort; the per-action check still guards content */
    }
  }

  private async listCredentials(s: Session): Promise<JSONValue> {
    if (!this.credentials) return { status: "error", error: "credential broker not available" };
    if (!s.credentialMetadata) {
      return {
        status: "error",
        error:
          "credential metadata was not approved for this session — " +
          "open with credentials_metadata or use plow_browser_request",
      };
    }
    const items = await this.credentials.whatsHere(s.lastUrl || "https://invalid.invalid/");
    this.audit("credential_metadata", { session: s.handle, op: "list" });
    return {
      status: "completed",
      items: items.map((i) => ({
        id: i.id,
        title: i.title,
        category: i.category,
        username: i.username,
        urls: i.urls,
        matches_this_page: i.matchesThisPage,
      })),
    };
  }

  private async describeItem(s: Session, itemId: string): Promise<JSONValue> {
    if (!this.credentials) return { status: "error", error: "credential broker not available" };
    if (itemId === "") return { status: "error", error: "missing item" };
    if (!s.credentialMetadata && !s.credentialItems.has(itemId)) {
      return { status: "error", error: "no credential access approved for this item" };
    }
    const item = await this.credentials.describeItem(itemId);
    this.audit("credential_metadata", { session: s.handle, op: "describe", item: itemId });
    return { status: "completed", ...item };
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
  ): Promise<JSONValue> {
    if (!this.credentials) return { status: "error", error: "credential broker not available" };
    if (selector === "" || itemId === "" || field === "") {
      return { status: "error", error: "fill_secret requires selector, item, field" };
    }
    if (!s.credentialItems.has(itemId)) {
      this.audit("credential_denied", {
        session: s.handle,
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
        session: s.handle,
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
        session: s.handle,
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
        session: s.handle,
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
          session: s.handle,
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
          session: s.handle,
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
        session: s.handle,
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
      session: s.handle,
      item: itemId,
      field,
      origin: frameHost,
    });
    return { status: "completed", ok: true, frame };
  }
}
