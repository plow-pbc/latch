/**
 * Drive the REAL fill branch of the ported Session against stub Playwright
 * objects — the TypeScript successor to e2e/fixtures/fillProbe.py. No Python, no
 * browser: the stubs implement the structural Playwright seam from session.ts.
 *
 * The question is not "does the mark work" (that is the MASK_JS literal, tested
 * directly) but "does the mark land on the same node the value does". So this
 * drives `Session.handle` and reports which Playwright calls it made, in order.
 * A filled value is never traced, printed, or returned — only its length.
 *
 * Node's Playwright API is async, so every stub method returns a promise; the
 * Python fixture's sync shape is the only thing that changed.
 */
import {
  DEFAULT_ACTION_TIMEOUT_MS,
  Session,
  TYPED_CHARS,
  TYPING_MAX_MS,
  type ContextLike,
  type FrameLike,
  type HandleLike,
  type JSHandleLike,
  type PageFunction,
  type PageLike,
} from "../src/index.js";
// The page scripts are now FUNCTIONS; the stub matches on identity (===), which
// also makes the stub track the real call surface — a renamed/dropped script
// fails to match instead of silently returning a canned value.
import {
  DOC_TOKEN_JS,
  FIELD_CAP_JS,
  HELD_MATCHES_JS,
  KEYS_DROPPED_JS,
  MASK_JS,
  NOTHING_LANDED_JS,
  TYPEABLE_JS,
  UNMASK_JS,
  VALUE_SNAPSHOT_JS,
  WAS_MARKED_JS,
} from "../src/pageScripts.js";

type Any = unknown;

/** What `evaluateHandle` returns: a reference the server passes back. */
class HandleRef implements JSHandleLike {
  constructor(readonly value: Any) {}
  dispose(): void {}
}

export interface ProbeResult {
  trace: string[];
  error: string | null;
  marked: boolean;
  result: Record<string, Any> | null;
  value_kept: boolean;
  ledgered: boolean;
  typed_delay: number | null;
  typed_len: number | null;
  typed_has_cr: boolean;
  type_calls: number;
  key_timeout_max: number | null;
  key_timeout_min: number | null;
  node_len: number;
  asked_len: number;
}

interface HandleOpts {
  detachBeforeFill?: boolean;
  maskResult?: string;
  marked?: boolean;
  value?: string;
  partialFill?: boolean;
  documentToken?: string;
  typeFails?: boolean;
  typeable?: string;
  dropsKeys?: boolean;
  assignFails?: boolean;
  maxLength?: number;
  rewrites?: (t: string) => string;
}

/** One resolved DOM node. */
class Handle implements HandleLike {
  marked: boolean;
  value: string;
  typedDelay: number | null = null;
  typed: string | null = null;
  keyTimeoutMax: number | null = null;
  keyTimeoutMin: number | null = null;
  typeCalls = 0;
  private o: HandleOpts;

  constructor(private trace: string[], o: HandleOpts = {}) {
    this.o = o;
    this.marked = o.marked ?? false;
    this.value = o.value ?? "";
  }

  async evaluate(fn: PageFunction, arg?: Any): Promise<Any> {
    if (fn === DOC_TOKEN_JS) return this.o.documentToken ?? "doc-1";
    if (fn === FIELD_CAP_JS) return this.o.maxLength ?? -1;
    if (fn === HELD_MATCHES_JS) return (this.value || "") === (arg ?? "");
    if (fn === TYPEABLE_JS) return this.o.typeable ?? "single-line";
    if (fn === KEYS_DROPPED_JS) {
      const wanted = (arg as string) ?? "";
      const now = this.value || "";
      return now !== wanted && wanted.startsWith(now);
    }
    if (fn === NOTHING_LANDED_JS) {
      const previous = arg instanceof HandleRef ? (arg.value as string) : (arg as string);
      const now = this.value || "";
      return now === "" || now === previous;
    }
    if (fn === VALUE_SNAPSHOT_JS) return this.value || "";
    if (fn === MASK_JS) {
      this.marked = true;
      this.trace.push("handle.evaluate:mark");
      return this.o.maskResult ?? "stylesheet";
    }
    if (fn === UNMASK_JS) {
      this.marked = false;
      this.trace.push("handle.evaluate:unmark");
      return true;
    }
    if (fn === WAS_MARKED_JS) return this.marked;
    this.trace.push("handle.evaluate:other");
    return null;
  }

  async evaluateHandle(fn: PageFunction, arg?: Any): Promise<JSHandleLike> {
    return new HandleRef(await this.evaluate(fn, arg));
  }

  async fill(value: string): Promise<void> {
    if (this.o.detachBeforeFill) {
      this.trace.push("handle.assign-failed");
      throw new Error("Element is not attached to the DOM");
    }
    if (this.o.assignFails && this.typed !== null) {
      this.trace.push("handle.assign-failed");
      throw new Error("Cannot type text into input[type=number]");
    }
    this.value = this.o.rewrites ? this.o.rewrites(value) : value;
    this.trace.push("handle.assign");
  }

  async type(text: string, opts?: { delay?: number; timeout?: number }): Promise<void> {
    this.typedDelay = opts?.delay ?? null;
    if (this.trace[this.trace.length - 1] !== "handle.type") this.trace.push("handle.type");
    if (this.o.typeFails) {
      this.trace[this.trace.length - 1] = "handle.type-failed";
      throw new Error("Element is not attached to the DOM");
    }
    this.typed = (this.typed ?? "") + text;
    this.typeCalls += 1;
    // A millisecond per key, so the shared deadline visibly advances between the
    // first key and the last — a per-key timeout would show no gap.
    await new Promise((r) => setTimeout(r, 1));
    const t = opts?.timeout ?? 0;
    if (this.keyTimeoutMax === null || t > this.keyTimeoutMax) this.keyTimeoutMax = t;
    if (this.keyTimeoutMin === null || t < this.keyTimeoutMin) this.keyTimeoutMin = t;
    if (this.o.dropsKeys) return;
    let landed = (this.value || "") + text;
    if (this.o.rewrites) landed = this.o.rewrites(landed);
    this.value = landed;
    if (this.o.partialFill && this.typeCalls > 1) {
      this.trace[this.trace.length - 1] = "handle.type-failed";
      throw new Error("Element is not attached to the DOM");
    }
  }
}

/** Its own type, so a scenario can say WHICH frame's failure came back — the
 * generic "selector not found" fallback is an Error too. Named to match the
 * Python probe's `Hidden`/`Detached` (the tests assert on the class name). */
class Hidden extends Error {
  constructor(m: string) {
    super(m);
    this.name = "Hidden";
  }
}
class Detached extends Error {
  constructor(m: string) {
    super(m);
    this.name = "Detached";
  }
}

interface FrameOpts extends HandleOpts {
  nodes?: Record<string, Handle | undefined> | null;
  documentToken?: string;
  hides?: boolean;
  detached?: boolean;
}

class Frame implements FrameLike {
  handle: Handle;
  private o: FrameOpts;
  constructor(private trace: string[], o: FrameOpts = {}) {
    this.o = o;
    this.handle = new Handle(trace, o);
  }
  private node(selector: string): Handle | null {
    return this.o.nodes == null ? this.handle : (this.o.nodes[selector] ?? null);
  }
  url(): string {
    return "https://pizza.example/login";
  }
  async evaluate(fn: PageFunction): Promise<Any> {
    if (fn === DOC_TOKEN_JS) return this.o.documentToken ?? "doc-1";
    return [];
  }
  async $(selector: string): Promise<HandleLike | null> {
    return this.node(selector);
  }
  isDetached(): boolean {
    return this.o.detached ?? false;
  }
  parentFrame(): FrameLike | null {
    return null;
  }
  async click(): Promise<void> {}
  async waitForSelector(selector: string): Promise<HandleLike | null> {
    this.trace.push("frame.wait_for_selector");
    if (this.o.detached) throw new Detached("frame was detached");
    const node = this.node(selector);
    if (node === null) throw new Error(`selector not found: ${selector}`);
    if (this.o.hides) throw new Hidden(`${selector} never became visible`);
    return node;
  }
}

class Page implements PageLike {
  frameList: Frame[];
  documentToken = "doc-1";
  urlValue = "https://pizza.example/login";
  private ctx: ContextLike;
  constructor(frame: Frame, extraFrames: Frame[] = []) {
    this.frameList = [...extraFrames, frame];
    const self = this;
    this.ctx = {
      on() {},
      pages() {
        return [self];
      },
    };
  }
  url(): string {
    return this.urlValue;
  }
  async title(): Promise<string> {
    return "";
  }
  frames(): FrameLike[] {
    return this.frameList;
  }
  context(): ContextLike {
    return this.ctx;
  }
  async evaluate(): Promise<Any> {
    return this.documentToken;
  }
  async goto(): Promise<unknown> {
    return undefined;
  }
  async goBack(): Promise<unknown> {
    return undefined;
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async innerText(): Promise<string> {
    return "";
  }
  async bringToFront(): Promise<void> {}
  async waitForTimeout(): Promise<void> {}
}

interface RunOpts extends HandleOpts {
  documentUrl?: string;
}

export async function run(cmd: Record<string, Any>, o: RunOpts = {}): Promise<ProbeResult> {
  const trace: string[] = [];
  const frame = new Frame(trace, o);
  const page = new Page(frame);
  const session = new Session(page);
  const out: ProbeResult = {
    trace,
    error: null,
    marked: false,
    result: null,
    value_kept: true,
    ledgered: false,
    typed_delay: null,
    typed_len: null,
    typed_has_cr: false,
    type_calls: 0,
    key_timeout_max: null,
    key_timeout_min: null,
    node_len: 0,
    asked_len: 0,
  };
  try {
    const result = await session.handle({ ...cmd } as Record<string, never>);
    const keep: Record<string, Any> = {};
    for (const k of ["ok", "mask", "frame", "frame_url", "frame_token", "cap", "altered"]) {
      if (k in result) keep[k] = (result as Record<string, Any>)[k];
    }
    out.result = keep;
  } catch (exc) {
    const name = (exc as Error).name;
    out.error = name === "Error" ? "RuntimeError" : name;
  }
  out.marked = frame.handle.marked;
  out.value_kept = frame.handle.value === (o.value ?? "");
  out.ledgered = session.trackedForActivePage().length > 0;
  out.typed_delay = frame.handle.typedDelay;
  out.asked_len = String((cmd.value as string) ?? "").length;
  out.typed_len = frame.handle.typed === null ? null : frame.handle.typed.length;
  out.typed_has_cr = frame.handle.typed !== null && frame.handle.typed.includes("\r");
  out.type_calls = frame.handle.typeCalls;
  out.key_timeout_max = frame.handle.keyTimeoutMax;
  out.key_timeout_min = frame.handle.keyTimeoutMin;
  out.node_len = (frame.handle.value || "").length;
  return out;
}

export const constants = {
  typed_chars: TYPED_CHARS,
  action_timeout_ms: DEFAULT_ACTION_TIMEOUT_MS,
  typing_max_ms: TYPING_MAX_MS,
};

/**
 * A fill that fails AFTER changing a node, on a page where the selector resolves
 * in a later frame too. A failure in the first frame must NOT become a success
 * in the second — that leaves two fields holding something and reports the wrong
 * identity.
 */
export async function twoFrames(): Promise<{
  error: string | null;
  result: Record<string, Any> | null;
  second_len: number;
  first_changed: boolean;
  trace: string[];
}> {
  const trace: string[] = [];
  const first = new Frame(trace, { partialFill: true, value: "1 Elm St", documentToken: "doc-a" });
  const second = new Frame(trace, { documentToken: "doc-b" });
  const page = new Page(second, [first]);
  const session = new Session(page);
  let error: string | null = null;
  let result: Record<string, Any> | null = null;
  try {
    result = (await session.handle(
      { action: "fill", selector: "#pass", value: "hunter2", mask: true },
    )) as Record<string, Any>;
  } catch (exc) {
    const name = (exc as Error).name;
    error = name === "Error" ? "RuntimeError" : name;
  }
  return {
    error,
    result,
    second_len: (second.handle.value || "").length,
    first_changed: first.handle.value !== "1 Elm St",
    trace,
  };
}

/** Which frame's failure comes back: a frame that held the field and hid it must
 * outrank one that went away, whatever the DOM order. */
export async function ranked(
  withHolder = true,
  holderFirst = true,
): Promise<{ error: string | null; tried: number }> {
  const trace: string[] = [];
  const holder = withHolder
    ? new Frame(trace, { nodes: { "#pass": new Handle(trace) }, hides: true })
    : null;
  const gone = new Frame(trace, { nodes: {}, detached: true });
  const siblings = (holderFirst ? [holder, gone] : [gone, holder]).filter(
    (f): f is Frame => f !== null,
  );
  const session = new Session(new Page(new Frame(trace, { nodes: {} }), siblings));
  let error: string | null = null;
  try {
    await session.handle({ action: "fill", selector: "#pass", value: "x" });
  } catch (exc) {
    const name = (exc as Error).name;
    error = name === "Error" ? "RuntimeError" : name;
  }
  return { error, tried: trace.filter((t) => t === "frame.wait_for_selector").length };
}

type LedgerStep =
  | { cmd: Record<string, Any> }
  | { navigate: string }
  | { route: string }
  | { drop_sibling: true }
  | { frame_navigated: string }
  | { rerender: string }
  | { vanish: string }
  | { refuse: string };

/** Run a sequence of commands against ONE session and report what the mask
 * ledger did. Values never leave this function. */
export async function ledger(script: LedgerStep[]): Promise<{
  steps: { step: string; result: Record<string, Any> | null }[];
  tracked: string[];
  marked: Record<string, boolean>;
  sibling_marked: boolean;
}> {
  const trace: string[] = [];
  const nodes: Record<string, Handle | undefined> = {
    "#pass": new Handle(trace),
    "#addr": new Handle(trace),
  };
  const frame = new Frame(trace, { nodes });
  const siblingNodes: Record<string, Handle | undefined> = { "#pass": new Handle(trace) };
  const sibling = new Frame(trace, { nodes: siblingNodes, documentToken: "doc-sibling" });
  const page = new Page(frame, [sibling]);
  const session = new Session(page);
  const steps: { step: string; result: Record<string, Any> | null }[] = [];
  for (const step of script) {
    if ("navigate" in step) {
      page.urlValue = step.navigate;
      page.documentToken = `doc-${step.navigate}`;
      steps.push({ step: "navigate", result: null });
    } else if ("route" in step) {
      page.urlValue = step.route;
      steps.push({ step: "route", result: null });
    } else if ("drop_sibling" in step) {
      page.frameList = page.frameList.filter((f) => f !== sibling);
      steps.push({ step: "drop_sibling", result: null });
    } else if ("frame_navigated" in step) {
      (frame as unknown as { o: FrameOpts }).o.documentToken = step.frame_navigated;
      steps.push({ step: "frame_navigated", result: null });
    } else if ("rerender" in step) {
      nodes[step.rerender]!.marked = false;
      steps.push({ step: "rerender", result: null });
    } else if ("vanish" in step) {
      delete nodes[step.vanish];
      steps.push({ step: "vanish", result: null });
    } else if ("refuse" in step) {
      (nodes[step.refuse] as unknown as { o: HandleOpts }).o.maskResult = "unmasked";
      steps.push({ step: "refuse", result: null });
    } else {
      let keep: Record<string, Any> | null;
      try {
        const result = await session.handle({ ...step.cmd } as Record<string, never>);
        keep = {};
        for (const k of ["ok", "mask"]) if (k in result) keep[k] = (result as Record<string, Any>)[k];
      } catch (exc) {
        keep = { error: (exc as Error).name === "Error" ? "RuntimeError" : (exc as Error).name };
      }
      steps.push({ step: String(step.cmd.action), result: keep });
    }
  }
  return {
    steps,
    tracked: session.trackedForActivePage(),
    marked: Object.fromEntries(Object.entries(nodes).map(([sel, n]) => [sel, n?.marked ?? false])),
    sibling_marked: siblingNodes["#pass"]!.marked,
  };
}

export { Frame, Handle, Page, Hidden, Detached };
