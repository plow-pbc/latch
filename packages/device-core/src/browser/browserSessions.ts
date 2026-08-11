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
 *   recovery is a browser_request intent that widens the scope;
 * - credential values flow op → here → a frame-targeted fill on an approved
 *   origin, and are dropped immediately. They never appear in results or audit.
 *
 * This layer is the cage: seatbelt cannot confine a browser (network is
 * all-or-nothing), so scope enforcement lives in trusted TS. What the origin
 * bound does NOT do: it is not network egress control — page JS (the site's
 * own, or agent-injected eval) can fetch() anywhere CORS allows. It bounds
 * what the agent observes/interacts with and where credentials get typed.
 */
import crypto from "node:crypto";
import { JSONValue, jv, originMatches, normalizeOrigin } from "@domo/protocol";
import { BrowserHost } from "./browserHost.js";
import { CredentialBroker, CredentialError } from "./credentialBroker.js";

type AuditFn = (event: string, fields: { [k: string]: JSONValue }) => void;

interface Session {
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

export class BrowserSessions {
  private session: Session | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly host: BrowserHost,
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

  /** Open a new session (called only after an approved intent). */
  async open(
    intentId: string,
    agentId: string,
    origins: string[],
    credentialMetadata: boolean,
  ): Promise<JSONValue> {
    if (this.session && this.session.agentId !== agentId) {
      return { status: "error", error: "browser is in use by another agent" };
    }
    if (this.session) await this.close(this.session.handle, "reopened");

    // Warm the browser now. browser_open is deferrable, so a cold Camoufox
    // start (~30s) absorbs into the deferred handle; every later `browser`
    // action is non-deferrable and must answer well inside the relay's ~20s
    // per-exchange ceiling, which it can only do against an already-running
    // browser. Failing here (no runtime, crash-looped) is an honest open error.
    try {
      await this.host.ensureReady();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "error", error: `browser failed to start: ${message}` };
    }

    const session: Session = {
      handle: crypto.randomUUID(),
      agentId,
      origins: origins.map(normalizeOrigin),
      credentialMetadata,
      credentialItems: new Set(),
      lastActivity: Date.now(),
      lastUrl: "",
      knownPageCount: 1,
    };
    this.session = session;
    this.armIdleTimer();
    this.audit("browser_session_opened", {
      intentId,
      session: session.handle,
      origins: session.origins,
      credential_metadata: credentialMetadata,
    });
    return { status: "completed", session: session.handle, origins: session.origins };
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
    for (const o of origins) {
      const n = normalizeOrigin(o);
      if (!s.origins.includes(n)) s.origins.push(n);
    }
    s.origins.sort();
    for (const i of items) s.credentialItems.add(i);
    if (credentialMetadata) s.credentialMetadata = true;
    s.lastActivity = Date.now();
    this.audit("browser_session_extended", {
      intentId,
      session: s.handle,
      origins: s.origins,
      items: [...s.credentialItems].sort(),
    });
    return {
      status: "completed",
      session: s.handle,
      origins: s.origins,
      items: [...s.credentialItems].sort(),
    };
  }

  async close(handle: string, reason: string): Promise<JSONValue> {
    const s = this.session;
    if (!s || s.handle !== handle) return { status: "error", error: "unknown session" };
    this.session = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.host.shutdown();
    this.host.resetBreaker();
    this.audit("browser_session_closed", { session: handle, reason });
    return { status: "completed" };
  }

  /** Close whatever session an agent holds (revocation/disconnect path). */
  async closeForAgent(agentId: string, reason: string): Promise<void> {
    if (this.session?.agentId === agentId) await this.close(this.session.handle, reason);
  }

  async closeAll(reason: string): Promise<void> {
    if (this.session) await this.close(this.session.handle, reason);
  }

  private validate(agentId: string, handle: string): Session | string {
    const s = this.session;
    if (!s || s.handle !== handle) return "unknown session (open one with browser_open)";
    if (s.agentId !== agentId) return "session belongs to a different agent";
    return s;
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const s = this.session;
      if (!s) return;
      if (Date.now() - s.lastActivity >= this.idleMs) {
        void this.close(s.handle, "idle");
      } else {
        this.armIdleTimer();
      }
    }, this.idleMs + 1000);
    this.idleTimer.unref?.();
  }

  /** Execute one agent command inside an approved session. */
  async command(agentId: string, handle: string, params: JSONValue): Promise<JSONValue> {
    const s = this.validate(agentId, handle);
    if (typeof s === "string") return { status: "error", error: s };
    s.lastActivity = Date.now();

    const p = jv(params);
    const action = p.get("action").str ?? "";

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
            `[${s.origins.join(", ")}] — use browser_request to ask for it, ` +
            `or goto an approved origin`,
        };
      }

      switch (action) {
        case "credentials":
          return await this.listCredentials(s);
        case "describe_item":
          return await this.describeItem(s, p.get("item").str ?? "");
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
                `[${s.origins.join(", ")}] — use browser_request to widen the session`,
            };
          }
          return await this.serverAction(s, { action: "goto", url: target });
        }
        default: {
          // Pass-through actions; the server rejects unknown ones.
          const forwarded: { [k: string]: JSONValue } = { action };
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
          return await this.serverAction(s, forwarded);
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit("browser_command", {
        session: s.handle,
        action,
        url: stripQuery(s.lastUrl),
        error: message,
      });
      return { status: "error", error: message };
    }
  }

  /** Send to the server, then observe where we landed and sweep popups. */
  private async serverAction(
    s: Session,
    action: { [k: string]: JSONValue },
  ): Promise<JSONValue> {
    const result = await this.host.sendAction(action);
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
    });

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
        `locked; use browser_request to ask for this origin`;
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
      const pages = await this.host.sendAction({ action: "pages" });
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
          "open with credentials_metadata or use browser_request",
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
   * selector is actually in → that frame's origin must be approved → the op
   * broker releases against the DEVICE-observed frame URL (its own item-origin
   * check applies) → frame-targeted fill → value dropped.
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
        error: `item ${itemId} is not approved for this session — use browser_request with credential_items`,
      };
    }

    const located = await this.host.sendAction({ action: "locate", selector });
    const frame = typeof located.frame === "number" ? located.frame : 0;
    const frameUrl = typeof located.frame_url === "string" ? located.frame_url : "";
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

    let secret: string;
    try {
      secret = await this.credentials.getField(itemId, field, frameUrl);
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
      return { status: "error", error: `credential release refused: ${message}` };
    }

    try {
      await this.host.sendAction({ action: "fill", selector, value: secret, frame });
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
