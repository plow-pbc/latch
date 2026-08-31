/**
 * One live browser + the currently active page — the TypeScript port of the
 * `Session` class in the old vendor/browser-server/server.py.
 *
 * Behavior is preserved branch for branch; the one systematic change is that
 * Node's Playwright API is asynchronous and method-based where Python's sync API
 * was attribute-based (`frame.url()` not `frame.url`, `await el.evaluate(...)`
 * not `el.evaluate(...)`). The structural interfaces below are the seam: the
 * real Playwright objects satisfy them, and so do the test stubs, so the same
 * logic runs under vitest with no browser — the role fillProbe.py used to play.
 *
 * A filled value is never traced, logged, or returned; masking keeps it out of
 * screenshots and `forms`.
 */
import { JSONValue } from "@domo/protocol";
import {
  DOC_TOKEN_JS,
  FIELD_CAP_JS,
  FIELD_JS,
  HELD_MATCHES_JS,
  KEYS_DROPPED_JS,
  LINKS_JS,
  MASK_JS,
  NOTHING_LANDED_JS,
  SCROLL_JS,
  TABLES_JS,
  TYPEABLE_JS,
  UNMASK_JS,
  VALUE_SNAPSHOT_JS,
  WAS_MARKED_JS,
} from "./pageScripts.js";

// ---- Structural Playwright seam ------------------------------------------
// Just the surface Session touches. Real Playwright satisfies it; so do stubs.

/** What `evaluate` accepts: a real function (Playwright serializes and CALLS it
 * with the element/page + arg) or a plain expression string. A string is
 * evaluated, never called — see pageScripts.ts for why the page logic is
 * functions, not strings. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PageFunction = string | ((...args: any[]) => unknown);

export interface JSHandleLike {
  dispose(): Promise<void> | void;
}
export interface HandleLike {
  evaluate(pageFunction: PageFunction, arg?: unknown): Promise<unknown>;
  evaluateHandle(pageFunction: PageFunction, arg?: unknown): Promise<JSHandleLike>;
  fill(value: string, opts?: { timeout?: number }): Promise<void>;
  type(text: string, opts?: { delay?: number; timeout?: number }): Promise<void>;
}
export interface FrameLike {
  url(): string;
  evaluate(pageFunction: PageFunction, arg?: unknown): Promise<unknown>;
  /** querySelector — Playwright names it `$`, NOT `querySelector`. */
  $(selector: string): Promise<HandleLike | null>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<HandleLike | null>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  isDetached(): boolean;
  parentFrame(): FrameLike | null;
}
export interface RequestLike {
  frame(): FrameLike;
  isNavigationRequest(): boolean;
  method(): string;
}
export interface ResponseLike {
  status(): number;
  url(): string;
  request(): RequestLike;
  headers(): Record<string, string>;
}
export interface ContextLike {
  on(event: "request" | "response", handler: (x: never) => void): void;
  pages(): PageLike[];
}
export interface PageLike {
  url(): string;
  title(): Promise<string>;
  frames(): FrameLike[];
  context(): ContextLike;
  evaluate(pageFunction: PageFunction, arg?: unknown): Promise<unknown>;
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  goBack(opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  screenshot(opts?: {
    type?: string;
    quality?: number;
    fullPage?: boolean;
  }): Promise<Buffer>;
  innerText(selector: string): Promise<string>;
  bringToFront(): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
}

// ---- Tunables (identical to server.py's, and asserted against by tests) ----

/** How many refused requests one reply can carry back. */
export const MAX_FAILED_REQUESTS = 5;
/** How many in-flight requests are remembered by who asked for them. */
export const MAX_REMEMBERED_REQUESTS = 200;
/** Kept off a refused request beyond status/method/origin/initiator. */
const FAILED_REQUEST_HEADERS = ["retry-after", "server"] as const;
/** How long one element action waits by default. */
export const DEFAULT_ACTION_TIMEOUT_MS = 3000;
/** How often a click re-scans the frames for its selector while waiting. */
const SCAN_INTERVAL_MS = 50;
/** What every action that moves the page gives it to settle afterwards. */
const SETTLE_MS = 1000;
/** Per-character `el.type` delay — what makes a fill keystrokes, not an assign. */
const KEY_DELAY_MS = 45;
/** What a key may cost beyond its delay (dispatch + actionability check). */
const KEY_OVERHEAD_MS = 30;
/** Only the last TYPED_CHARS of a value go through the keyboard; the head is
 * assigned. A credential is shorter than this and is typed whole. */
export const TYPED_CHARS = 64;
export const TYPING_MAX_MS = TYPED_CHARS * (KEY_DELAY_MS + KEY_OVERHEAD_MS);

type Obj = { [k: string]: JSONValue };

const now = (): number => performance.now();
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Scheme and host, and nothing else. A url is the page's to choose, and every
 * other part can carry a secret (a query, userinfo, a path). The origin is the
 * part that says who refused, and the only part nobody can write into.
 */
export function origin(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/@]*@)?([^/?#]*)/i.exec(url);
  return m === null ? "" : m[1] + m[2].split("@").pop();
}

/**
 * The value as this node will receive it. CR and CRLF collapse to one LF, and a
 * node whose kind is not "multiline" loses the break entirely — which is what
 * lets a break-bearing value still go in as real keys, and why the tail can
 * never press Enter at a form.
 */
export function asReceived(value: string, kind: string): string {
  const received = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return kind === "multiline" ? received : received.replace(/\n/g, "");
}

/** What `maxlength` counts: UTF-16 code units, not code points. */
export function utf16Units(value: string): number {
  return value.length;
}

/** One entry the browser keeps about a request the site refused. */
interface FailedEntry extends Obj {
  status: number;
  method: string;
  origin: string;
  initiator: string;
}

export class Session {
  page: PageLike;
  /** page -> {(document token, selector)} that hold something concealed. */
  private masked = new Map<PageLike, Set<string>>();
  /** page -> the document it was showing when we last looked. */
  private seenDocument = new Map<PageLike, string>();
  /** Requests the site refused, oldest first, waiting for the next reply. */
  private failed: FailedEntry[] = [];
  /** request -> the origin of the document that asked, oldest first. */
  private askedBy = new Map<RequestLike, string | null>();

  constructor(page: PageLike) {
    this.page = page;
    const ctx = page.context();
    ctx.on("request", ((r: RequestLike) => void this.noteRequest(r)) as (x: never) => void);
    ctx.on("response", ((r: ResponseLike) => void this.noteResponse(r)) as (x: never) => void);
  }

  /** Every masked target for the active page keyed "token:selector". */
  private targets(): Set<string> {
    let s = this.masked.get(this.page);
    if (!s) {
      s = new Set();
      this.masked.set(this.page, s);
    }
    return s;
  }

  /** Testing hook: the tracked (token, selector) pairs for the active page. */
  trackedForActivePage(): string[] {
    return [...(this.masked.get(this.page) ?? [])].sort();
  }

  get pages(): PageLike[] {
    return this.page.context().pages();
  }

  /**
   * A page showing a NEW DOCUMENT is not the page anything was filled on. A
   * same-document navigation is not that: the nodes are still there, the values
   * still in them, and the marks still have to go back on.
   */
  private async forgetNavigated(): Promise<void> {
    let token: string;
    try {
      token = (await this.page.evaluate(DOC_TOKEN_JS)) as string;
    } catch {
      // Mid-navigation, or a page that will not evaluate. Keeping the record is
      // the safe answer: a stale mask is dropped when it fails to resolve.
      return;
    }
    if (this.seenDocument.get(this.page) !== token) {
      this.seenDocument.set(this.page, token);
      this.masked.delete(this.page);
    }
  }

  private rememberMasked(documentToken: string, selector: string): void {
    this.targets().add(`${documentToken}:${selector}`);
  }

  /** Called when a field is filled with something the vault does not conceal:
   * whatever is in it now is not a secret, so re-marking it later would hide an
   * address the agent was told to check. */
  private forgetMasked(documentToken: string, selector: string): void {
    this.masked.get(this.page)?.delete(`${documentToken}:${selector}`);
  }

  /** Every frame of the active page, by the document it is showing. */
  private async framesByToken(): Promise<Map<string, FrameLike>> {
    const found = new Map<string, FrameLike>();
    for (const frame of this.page.frames()) {
      try {
        const token = (await frame.evaluate(DOC_TOKEN_JS)) as string;
        if (!found.has(token)) found.set(token, frame);
      } catch {
        continue;
      }
    }
    return found;
  }

  /**
   * Put the mark back on every masked field of the active page. Returns the
   * selector of a field that could NOT be masked, or null when every one is
   * covered. A field whose node has gone is dropped: it is not on the page, so
   * it is not on the screenshot either.
   */
  private async reapplyMasks(): Promise<string | null> {
    const targets = this.masked.get(this.page);
    if (!targets || targets.size === 0) return null;
    const frames = await this.framesByToken();
    for (const key of [...targets].sort()) {
      const idx = key.indexOf(":");
      const documentToken = key.slice(0, idx);
      const selector = key.slice(idx + 1);
      const frame = frames.get(documentToken);
      if (frame === undefined) {
        // That document is not on this page any more. Nothing of it is on
        // screen to hide.
        targets.delete(key);
        continue;
      }
      let el: HandleLike | null;
      try {
        el = await frame.$(selector);
      } catch {
        targets.delete(key);
        continue;
      }
      if (el === null) {
        targets.delete(key);
        continue;
      }
      if ((await el.evaluate(MASK_JS)) === "unmasked") return selector;
    }
    return null;
  }

  // ---- failed-request listeners (context-level) --------------------------

  /**
   * Remember which document asked, at the moment it asked. A frame's url is
   * whatever it is showing NOW, so reading it when the response arrives lets a
   * page issue a request it knows will fail, move to an approved origin, and
   * have the refusal read as that origin's. The snapshot is taken here instead.
   */
  private async noteRequest(request: RequestLike): Promise<void> {
    try {
      let originStr: string | null;
      try {
        const frame = request.frame();
        if (!request.isNavigationRequest()) {
          originStr = origin(frame.url());
        } else if (frame.parentFrame() === null) {
          // The top frame: the one the agent sees for itself. Marked here so
          // the answer path never asks about the frame again.
          originStr = null;
        } else {
          // A frame's own document load names NOBODY — neither the frame's url
          // nor its embedder's can stand in.
          originStr = "";
        }
      } catch {
        originStr = "";
      }
      this.askedBy.set(request, originStr);
      while (this.askedBy.size > MAX_REMEMBERED_REQUESTS) {
        const first = this.askedBy.keys().next().value as RequestLike;
        this.askedBy.delete(first);
      }
    } catch {
      /* a listener that raises takes the page with it */
    }
  }

  /**
   * Remember a request the site refused. Only 4xx/5xx, never a TOP-LEVEL
   * navigation (an agent sees that for itself). Nothing here may raise — it runs
   * on Playwright's event thread — and nothing here reads a body.
   */
  private noteResponse(response: ResponseLike): void {
    try {
      const request = response.request();
      const initiator = this.askedBy.has(request) ? this.askedBy.get(request)! : "";
      this.askedBy.delete(request);
      if (response.status() < 400 || initiator === null) return;
      const entry: FailedEntry = {
        status: response.status(),
        method: request.method(),
        origin: origin(response.url()),
        initiator,
      };
      const headers = response.headers();
      for (const name of FAILED_REQUEST_HEADERS) {
        const value = headers[name];
        if (value) entry[name.replace(/-/g, "_")] = String(value).slice(0, 100);
      }
      this.failed.push(entry);
      while (this.failed.length > MAX_FAILED_REQUESTS) this.failed.shift();
    } catch {
      /* a listener that raises takes the page with it */
    }
  }

  /**
   * Add what the page's requests did to a reply, and forget it. Every reply an
   * action produces goes through here — a result and an error alike — because a
   * refusal that arrives during the action that FAILED is the one most worth
   * having. Most recent first, reported once.
   */
  replyWithFailures(reply: Obj): Obj {
    if (this.failed.length > 0) {
      reply.failed_requests = [...this.failed].reverse();
      this.failed = [];
    }
    return reply;
  }

  /** Testing hook: how many in-flight requests are still remembered. */
  rememberedRequestCount(): number {
    return this.askedBy.size;
  }
  /** Testing hook: which context events the session subscribed to. */
  static subscribedEvents: string[] = [];

  /** Every response carries where we are, so the client can enforce scope and
   * notice popups without extra round-trips. */
  private envelope(result: Obj): Obj {
    const out: Obj = { ...result };
    try {
      out.url = this.page.url();
      out.page_count = this.pages.length;
    } catch {
      out.url = "";
      out.page_count = 0;
    }
    return out;
  }

  /** Does this frame have the selector right now? Instant, never waits. */
  private async holds(frame: FrameLike, selector: string): Promise<boolean> {
    try {
      return (await frame.$(selector)) !== null;
    } catch {
      return false;
    }
  }

  /** `framesFor` with each frame's index on the page alongside it. */
  private indexedFrames(cmd: Obj): [number, FrameLike][] {
    const base = "frame" in cmd ? Number(cmd.frame) : 0;
    return this.framesFor(cmd).map((fr, n) => [base + n, fr]);
  }

  /** Explicit frame index if given, else all frames (login forms hide in iframes). */
  private framesFor(cmd: Obj): FrameLike[] {
    if ("frame" in cmd) {
      const frames = this.page.frames();
      const i = Number(cmd.frame);
      if (!(i >= 0 && i < frames.length)) {
        throw new Error(`no frame ${i} (have ${frames.length})`);
      }
      return [frames[i]];
    }
    return this.page.frames();
  }

  /** `{altered:true}` when the field is not holding what was ASKED for. */
  private async kept(el: HandleLike, wanted: string): Promise<Obj> {
    return (await el.evaluate(HELD_MATCHES_JS, wanted)) ? {} : { altered: true };
  }

  /**
   * Put `value` into a resolved node so that the field ends on real keys. The
   * kind is handed in by the caller (it measured the cap with it). "" is
   * assigned whole; the rest have head assigned and the last TYPED_CHARS typed
   * one key at a time THROUGH THE HANDLE, which refocuses the marked node before
   * each so a segmented one-time-code control cannot scatter the tail into
   * sibling fields.
   */
  private async typeValue(el: HandleLike, value: string, kind: string): Promise<void> {
    if (!kind) {
      await el.fill(value, { timeout: DEFAULT_ACTION_TIMEOUT_MS });
      return;
    }
    value = asReceived(value, kind);
    // A tab in the part that WOULD be typed cannot be carried by the keys, so
    // the value is assigned whole instead. One in the head is not this branch's
    // business: the head is assigned either way.
    if (value.slice(-TYPED_CHARS).includes("\t")) {
      await el.fill(value, { timeout: DEFAULT_ACTION_TIMEOUT_MS });
      return;
    }
    await el.fill(value.slice(0, value.length - TYPED_CHARS), {
      timeout: DEFAULT_ACTION_TIMEOUT_MS,
    });
    // The whole tail draws on ONE budget, not one per key.
    const deadline = now() + TYPING_MAX_MS;
    for (const ch of value.slice(-TYPED_CHARS)) {
      const left = deadline - now();
      if (left <= 0) throw new Error("typing outran its budget");
      await el.type(ch, { delay: KEY_DELAY_MS, timeout: left });
    }
    if (await el.evaluate(KEYS_DROPPED_JS, value)) {
      // The field did not take the keys. Assign it — it lands the value or it
      // raises. It must never report a value that is not there.
      await el.fill(value, { timeout: DEFAULT_ACTION_TIMEOUT_MS });
    }
  }

  // ---- click / fill ------------------------------------------------------

  private async click(cmd: Obj): Promise<Obj> {
    const sel = String(cmd.selector);
    const budgetMs = Number(cmd.timeout_ms) || DEFAULT_ACTION_TIMEOUT_MS;
    const deadline = now() + budgetMs;
    let frames = this.indexedFrames(cmd);
    if (!("frame" in cmd)) {
      for (;;) {
        const holding: [number, FrameLike][] = [];
        for (const [i, fr] of frames) if (await this.holds(fr, sel)) holding.push([i, fr]);
        if (holding.length > 0) {
          frames = holding;
          break;
        }
        if (now() >= deadline) {
          throw new Error(`no frame has ${sel} after ${budgetMs}ms`);
        }
        await this.page.waitForTimeout(SCAN_INTERVAL_MS);
      }
    }

    let last: Error | null = null;
    for (let tried = 0; tried < frames.length; tried++) {
      const [i, fr] = frames[tried];
      const left = Math.floor((deadline - now()) / (frames.length - tried));
      if (left <= 0) {
        // The selector IS somewhere — the scan said so — but the budget went on
        // waiting. Saying "not found" here would be false.
        last = last ?? new Error(`found ${sel} with no time left to click it`);
        break;
      }
      try {
        await fr.click(sel, { timeout: left });
        await this.page.waitForTimeout(SETTLE_MS);
        return { ok: true, frame: i };
      } catch (exc) {
        last = exc as Error;
      }
    }
    throw last ?? new Error(`selector not found: ${sel}`);
  }

  private async fill(cmd: Obj): Promise<Obj> {
    const sel = String(cmd.selector);
    let last: Error | null = null;
    for (const [i, fr] of this.indexedFrames(cmd)) {
      // ONE resolved node for the whole fill. Resolving twice is the
      // re-resolution failure the mark exists to avoid.
      let el: HandleLike | null;
      try {
        el = await fr.waitForSelector(sel, { timeout: DEFAULT_ACTION_TIMEOUT_MS });
      } catch (exc) {
        // A frame holding the field and refusing to show it is the answer the
        // caller waits for, so it always wins. A frame that went away is worth
        // hearing only if nothing better is ever offered.
        if (await this.holds(fr, sel)) {
          last = exc as Error;
        } else if (fr.isDetached() && last === null) {
          last = exc as Error;
        }
        continue;
      }
      if (el === null) continue;
      // Only the SEARCH may move on to the next frame. Once a node resolves,
      // whatever happens to it is this fill's answer.
      const expected = cmd.frame_token;
      if (
        expected !== undefined &&
        expected !== null &&
        (await el.evaluate(DOC_TOKEN_JS)) !== expected
      ) {
        return { ok: false, mask: "moved", frame: i };
      }
      // The one thing knowable before touching the node: the field says how
      // much it holds, and this is more.
      const kind = (await el.evaluate(TYPEABLE_JS)) as string;
      const cap = (await el.evaluate(FIELD_CAP_JS)) as number;
      if (cap >= 0 && utf16Units(asReceived(String(cmd.value), kind)) > cap) {
        return { ok: false, mask: "too_long", cap, frame: i };
      }
      if (cmd.mask) {
        // Marked first, and only typed once the mark is known to have taken.
        const wasMarked = (await el.evaluate(WAS_MARKED_JS)) as boolean;
        const before = await el.evaluateHandle(VALUE_SNAPSHOT_JS);
        const state = (await el.evaluate(MASK_JS)) as string;
        if (state === "unmasked") {
          await before.dispose();
          return { ok: false, mask: state, frame: i };
        }
        try {
          await this.typeValue(el, String(cmd.value), kind);
        } catch (exc) {
          // Nothing landed: put the node back as it was found. Something did:
          // it is holding a value nobody can account for, so the mark stays.
          if (await el.evaluate(NOTHING_LANDED_JS, before)) {
            if (!wasMarked) await el.evaluate(UNMASK_JS);
          } else {
            this.rememberMasked((await el.evaluate(DOC_TOKEN_JS)) as string, sel);
          }
          await before.dispose();
          throw exc;
        }
        await before.dispose();
        this.rememberMasked((await el.evaluate(DOC_TOKEN_JS)) as string, sel);
        return { ok: true, mask: state, frame: i, ...(await this.kept(el, String(cmd.value))) };
      }
      // Not a secret. The mark comes off AFTER the value is in, never before.
      await this.typeValue(el, String(cmd.value), kind);
      await el.evaluate(UNMASK_JS);
      this.forgetMasked((await el.evaluate(DOC_TOKEN_JS)) as string, sel);
      return { ok: true, frame: i, ...(await this.kept(el, String(cmd.value))) };
    }
    throw last ?? new Error(`selector not found: ${sel}`);
  }

  // ---- the action dispatcher --------------------------------------------

  async handle(cmd: Obj, screenshotsDir: string): Promise<Obj> {
    const action = typeof cmd.action === "string" ? cmd.action : "";
    await this.forgetNavigated();

    if (action === "screenshot" || action === "forms") {
      // Nothing the agent looks at goes out over a field that should be covered
      // and is not.
      const exposed = await this.reapplyMasks();
      if (exposed !== null) return { ok: false, mask: "unmasked" };
    }

    if (action === "goto") {
      await this.page.goto(String(cmd.url), { timeout: 12000, waitUntil: "domcontentloaded" });
      await this.page.waitForTimeout(SETTLE_MS);
      return { title: await this.page.title() };
    }

    if (action === "pages") {
      const pages = this.pages;
      const list: Obj[] = [];
      for (let i = 0; i < pages.length; i++) {
        list.push({ i, url: pages[i].url(), title: await pages[i].title() });
      }
      return { pages: list, active: pages.indexOf(this.page) };
    }

    if (action === "use_page") {
      const pages = this.pages;
      const i = Number(cmd.index);
      if (!(i >= 0 && i < pages.length)) {
        throw new Error(`no page ${i} (have ${pages.length})`);
      }
      this.page = pages[i];
      await this.page.bringToFront();
      return { ok: true, title: await this.page.title() };
    }

    if (action === "back") {
      const was = this.page.url();
      await this.page.goBack({ timeout: 12000, waitUntil: "domcontentloaded" });
      await this.page.waitForTimeout(SETTLE_MS);
      return { title: await this.page.title(), moved: this.page.url() !== was };
    }

    if (action === "view") {
      const data = await this.page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
      return { data_b64: data.toString("base64"), mime: "image/jpeg" };
    }

    if (action === "screenshot") {
      const data = await this.page.screenshot({ type: "jpeg", quality: 70, fullPage: false });
      const path = `${screenshotsDir}/shot-${Date.now()}.jpg`;
      await writeFileBinary(path, data);
      return { data_b64: data.toString("base64"), mime: "image/jpeg", path };
    }

    if (action === "text") {
      const limit = cmd.max !== undefined ? Number(cmd.max) : 8000;
      return { text: (await this.page.innerText("body")).slice(0, limit) };
    }

    if (action === "eval") {
      return { result: (await this.page.evaluate(String(cmd.expression))) as JSONValue };
    }

    if (action === "click") return this.click(cmd);
    if (action === "fill") return this.fill(cmd);

    if (action === "locate") {
      const sel = String(cmd.selector);
      const frames = this.page.frames();
      for (let i = 0; i < frames.length; i++) {
        const fr = frames[i];
        let el: HandleLike | null;
        try {
          el = await fr.$(sel);
        } catch {
          continue;
        }
        if (el !== null) {
          return {
            frame: i,
            frame_url: fr.url(),
            frame_token: (await el.evaluate(DOC_TOKEN_JS)) as JSONValue,
          };
        }
      }
      throw new Error(`selector not found: ${sel}`);
    }

    if (action === "scroll") {
      const d = typeof cmd.direction === "string" ? cmd.direction : "down";
      await this.page.evaluate(SCROLL_JS[d] ?? SCROLL_JS.down);
      await this.page.waitForTimeout(SETTLE_MS);
      return { ok: true };
    }

    if (action === "wait") {
      await this.page.waitForTimeout(Math.round(Number(cmd.seconds ?? 1) * 1000));
      return { ok: true };
    }

    if (action === "url") return {};
    if (action === "title") return { title: await this.page.title() };
    if (action === "links") return { links: (await this.page.evaluate(LINKS_JS)) as JSONValue };

    if (action === "forms") {
      const fields: Obj[] = [];
      const frames = this.page.frames();
      for (let i = 0; i < frames.length; i++) {
        const fr = frames[i];
        let got: Obj[];
        try {
          got = (await fr.evaluate(FIELD_JS)) as Obj[];
        } catch {
          continue;
        }
        for (const f of got) {
          f.frame = i;
          f.frame_url = fr.url();
          fields.push(f);
        }
      }
      return { forms: fields };
    }

    if (action === "tables") return { tables: (await this.page.evaluate(TABLES_JS)) as JSONValue };

    throw new Error(`unknown action: ${action}`);
  }

  /** Public wrapper: run one action and wrap the result in the envelope. */
  async run(cmd: Obj, screenshotsDir: string): Promise<Obj> {
    return this.envelope(await this.handle(cmd, screenshotsDir));
  }
}

// Imported lazily so the pure logic (and its tests) never pull in node:fs.
async function writeFileBinary(path: string, data: Buffer): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, data);
}
