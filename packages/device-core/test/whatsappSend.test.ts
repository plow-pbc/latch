import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { WHATSAPP_SCRIPT, type WhatsAppAxNode, type WhatsAppNativeAdapter } from "../src/whatsappSend.js";

const PHONE = "15551234567";
const ARGS = ["hello\nsecond line 🍎", `whatsapp://send?phone=${PHONE}`, `${PHONE}@s.whatsapp.net`];

function node(identifier: string, role = "AXGroup", value: string | null = null, children: WhatsAppAxNode[] = []): WhatsAppAxNode {
  return { ref: identifier || Symbol(role), identifier, role, value, enabled: true, children };
}

function fixture() {
  const state = {
    body: "", phone: "+1 (555) 123-4567", heading: "Pat", frontmost: true, info: false,
    mainRef: "main", focusedRef: "", now: 0, infoCount: 0, escaped: 0, clipboardRevision: 0,
    headerRef: "header", composerRef: "composer", headerRole: "AXButton", composerRole: "AXTextArea", sendRole: "AXButton",
    duplicate: "", sendEnabled: true, staleDraft: false, sendThrows: false, modal: false, noWindow: false, controlsReady: true,
    identityChildren: null as WhatsAppAxNode[] | null,
    snapshotErrors: [] as string[],
    extra: [] as WhatsAppAxNode[], actions: [] as string[], restored: 0,
    onPaste: () => {}, onFocus: () => {}, onEscape: () => {}, onClipboard: () => {}, onPause: () => {},
  };
  const adapter: WhatsAppNativeAdapter = {
    now: () => state.now,
    pause: () => { state.now += 150; state.onPause(); },
    openChat: () => { state.actions.push("open"); },
    sameElement: (a, b) => a.ref === b.ref,
    snapshot: () => {
      const error = state.snapshotErrors.shift();
      if (error) throw new Error(error);
      const composer = node("ChatBar_ComposerTextView", state.composerRole, state.body);
      composer.ref = state.composerRef;
      const send = node("ChatBar_SendButton", state.sendRole);
      send.enabled = state.sendEnabled && (state.body !== "" || state.staleDraft);
      const header = node("NavigationBar_HeaderViewButton", state.headerRole, state.heading);
      header.ref = state.headerRef;
      const main = node("SceneWindow", "AXWindow", null, state.controlsReady ? [header, composer, send, ...state.extra] : []);
      main.ref = state.mainRef;
      if (state.duplicate && state.duplicate !== "info") main.children.push(node(state.duplicate));
      const roots = state.noWindow ? [] : [main];
      let focusedWindow = main;
      if (state.info) {
        const identity = node("contact-info-view-name-number-view", "AXGroup", null, state.identityChildren ?? [
          node("heading", "AXHeading", state.heading), node("phone", "AXStaticText", state.phone),
        ]);
        const sheet = node("sheet", "AXSheet", null, [identity]);
        if (state.duplicate === "info") sheet.children.push({ ...identity, ref: "second-info" });
        roots.push(sheet);
        focusedWindow = sheet;
      }
      if (state.modal) roots.push(node("unexpected-modal", "AXSheet"));
      return { frontmost: state.frontmost, roots, focusedWindow, focusedElement: { ...composer, ref: state.focusedRef } };
    },
    press: (element) => {
      if (element.identifier === "NavigationBar_HeaderViewButton") {
        state.actions.push("info"); state.info = true; state.infoCount++;
      } else if (element.identifier === "ChatBar_SendButton") {
        state.actions.push("send");
        if (state.sendThrows) throw new Error("AX failed after action");
      } else throw new Error("unexpected press");
    },
    escape: () => { state.actions.push("escape"); state.info = false; state.escaped++; state.onEscape(); },
    focus: (element) => { state.actions.push("focus"); state.focusedRef = element.ref as string; state.onFocus(); },
    paste: () => { state.actions.push("paste"); state.body = ARGS[0]!; state.onPaste(); },
    clipboard: () => {
      state.actions.push("clipboard");
      const owned = ++state.clipboardRevision;
      state.onClipboard();
      return {
        current: () => state.clipboardRevision === owned,
        restore: () => { if (state.clipboardRevision === owned) { state.actions.push("restore"); state.restored++; } },
      };
    },
  };
  const context: Record<string, unknown> = {};
  vm.runInNewContext(WHATSAPP_SCRIPT, context);
  context.nativeWhatsAppAdapter = () => adapter;
  return { state, run: (args = ARGS) => (context.run as (args: string[]) => string)(args) };
}

describe("fixed WhatsApp send controller", () => {
  it("proves the phone twice, pastes multiline Unicode, and presses Send exactly once", () => {
    const { state, run } = fixture();
    expect(run()).toBe("LATCH_SEND_ATTEMPTED");
    expect(state.body).toBe(ARGS[0]);
    expect(state.actions).toEqual(["open", "info", "escape", "clipboard", "focus", "paste", "info", "escape", "send", "restore"]);
    expect(state.restored).toBe(1);
  });

  it("waits for controls and transient sheets after navigation and info close", () => {
    const { state, run } = fixture();
    state.controlsReady = false;
    state.modal = true;
    state.onPause = () => { state.controlsReady = true; state.modal = false; };
    state.onEscape = () => { state.controlsReady = false; };
    expect(run()).toBe("LATCH_SEND_ATTEMPTED");
    expect(state.now).toBe(450);
    expect(state.actions.filter((action) => action === "send")).toHaveLength(1);
  });

  it("retries known transient AX reads during close waits without repeating actions", () => {
    const { state, run } = fixture();
    state.onEscape = () => { state.snapshotErrors.push("LATCH_AX_TRANSIENT:-25202", "LATCH_AX_TRANSIENT:-25204"); };
    expect(run()).toBe("LATCH_SEND_ATTEMPTED");
    expect(state.now).toBe(600);
    expect(state.actions.filter((action) => action === "escape")).toHaveLength(2);
    expect(state.actions.filter((action) => action === "paste")).toHaveLength(1);
    expect(state.actions.filter((action) => action === "send")).toHaveLength(1);
  });

  it("bounds repeated transient reads and does not retry other AX failures", () => {
    const stuck = fixture();
    stuck.state.snapshotErrors = Array.from({ length: 250 }, () => "LATCH_AX_TRANSIENT:-25204");
    expect(() => stuck.run()).toThrow("LATCH_RECIPIENT_UNVERIFIED");
    expect(stuck.state.now).toBeLessThan(31_000);
    expect(stuck.state.actions).toEqual(["open"]);
    const unsupported = fixture();
    unsupported.state.snapshotErrors = ["AX attribute unsupported"];
    expect(() => unsupported.run()).toThrow("LATCH_RECIPIENT_UNVERIFIED");
    expect(unsupported.state.now).toBe(0);
    expect(unsupported.state.actions).toEqual(["open"]);
  });

  it.each(["123456@g.us", "123456@lid", "15551234567", ""])('refuses unprovable recipient "%s" before opening anything', (recipient) => {
    const { state, run } = fixture();
    expect(() => run([ARGS[0]!, ARGS[1]!, recipient])).toThrow("LATCH_RECIPIENT_UNVERIFIED");
    expect(state.actions).toEqual([]);
  });

  it("refuses a URL that disagrees with the canonical approval", () => {
    const { state, run } = fixture();
    expect(() => run([ARGS[0]!, "whatsapp://send?phone=15559999999", ARGS[2]!])).toThrow("LATCH_RECIPIENT_UNVERIFIED");
    expect(state.actions).toEqual([]);
  });

  it.each(["+1 555 999 9999", "~15551234567", "@username", "Phone 15551234567", "+1 555 123 4567\n123", "１５５５１２３４５６７"])(
    "does not trust a numeric contact name when the secondary field is %s", (secondary) => {
      const { state, run } = fixture();
      state.heading = "+1 555 123 4567";
      state.phone = secondary;
      expect(() => run()).toThrow("LATCH_RECIPIENT_UNVERIFIED");
      expect(state.actions).not.toContain("clipboard");
      expect(state.actions).not.toContain("send");
    },
  );

  it("accepts phone formatting and bidi direction marks only inside the semantic phone field", () => {
    const { state, run } = fixture();
    state.phone = "\u2066+1\u00a0(555)\u202f123-4567\u2069";
    expect(run()).toBe("LATCH_SEND_ATTEMPTED");
  });

  it("accepts the observed single-group heading wrapper without reading the contact name", () => {
    const { state, run } = fixture();
    state.identityChildren = [
      node("", "AXGroup", null, [node("", "AXHeading", "15559999999")]),
      node("", "AXStaticText", "+1 555 123 4567"),
    ];
    expect(run()).toBe("LATCH_SEND_ATTEMPTED");
  });

  it("refuses ambiguous heading wrappers and group-style secondary controls", () => {
    for (const children of [
      [node("", "AXGroup", null, [node("", "AXHeading"), node("", "AXHeading")]), node("", "AXStaticText", PHONE)],
      [node("", "AXHeading", PHONE), node("", "AXButton", PHONE)],
    ]) {
      const { state, run } = fixture();
      state.identityChildren = children;
      expect(() => run()).toThrow("LATCH_RECIPIENT_UNVERIFIED");
      expect(state.actions).not.toContain("clipboard");
    }
  });

  it.each(["info", "ChatBar_ComposerTextView", "NavigationBar_HeaderViewButton", "ChatBar_SendButton", "SceneWindow"])(
    "refuses duplicate %s controls", (duplicate) => {
      const { state, run } = fixture();
      state.duplicate = duplicate;
      expect(() => run()).toThrow(/LATCH_(RECIPIENT|COMPOSER)_UNVERIFIED/);
      expect(state.actions).not.toContain("send");
    },
  );

  it("preserves an existing draft and refuses before clipboard or paste", () => {
    const { state, run } = fixture();
    state.body = "unfinished user draft";
    expect(() => run()).toThrow("LATCH_COMPOSER_UNVERIFIED");
    expect(state.body).toBe("unfinished user draft");
    expect(state.actions).not.toContain("clipboard");
  });

  it("refuses an empty AX value when the app still has an enabled draft Send button", () => {
    const { state, run } = fixture();
    state.staleDraft = true;
    expect(() => run()).toThrow("LATCH_COMPOSER_UNVERIFIED");
    expect(state.actions).not.toContain("clipboard");
    expect(state.actions).not.toContain("send");
  });

  it("refuses a focus change before paste and restores its clipboard", () => {
    const { state, run } = fixture();
    state.onFocus = () => { state.frontmost = false; };
    expect(() => run()).toThrow("LATCH_COMPOSER_UNVERIFIED");
    expect(state.actions).not.toContain("paste");
    expect(state.restored).toBe(1);
  });

  it("refuses a changed recipient after staging", () => {
    const { state, run } = fixture();
    state.onPaste = () => { state.phone = "+1 555 999 9999"; };
    expect(() => run()).toThrow("LATCH_RECIPIENT_UNVERIFIED");
    expect(state.infoCount).toBe(2);
    expect(state.actions).not.toContain("send");
    expect(state.restored).toBe(1);
  });

  it("refuses a changed body after the second recipient check", () => {
    const { state, run } = fixture();
    state.onEscape = () => { if (state.escaped === 2) state.body = "changed"; };
    expect(() => run()).toThrow("LATCH_COMPOSER_UNVERIFIED");
    expect(state.actions).not.toContain("send");
  });

  it.each(["heading", "headerRef", "composerRef"] as const)("refuses changed %s after closing the final identity pane, even with the same draft", (field) => {
    const { state, run } = fixture();
    state.onEscape = () => {
      if (state.escaped === 2) {
        state[field] = "other conversation";
        state.phone = "+1 555 999 9999";
      }
    };
    expect(() => run()).toThrow("LATCH_RECIPIENT_UNVERIFIED");
    expect(state.body).toBe(ARGS[0]);
    expect(state.actions).not.toContain("send");
  });

  it.each(["headerRole", "composerRole", "sendRole"] as const)("refuses an unexpected %s", (field) => {
    const { state, run } = fixture();
    state[field] = "AXStaticText";
    expect(() => run()).toThrow(/LATCH_(RECIPIENT|COMPOSER)_UNVERIFIED/);
    expect(state.actions).not.toContain("send");
  });

  it("refuses a replaced main window", () => {
    const { state, run } = fixture();
    state.onPaste = () => { state.mainRef = "different-window"; };
    expect(() => run()).toThrow("LATCH_COMPOSER_UNVERIFIED");
    expect(state.actions).not.toContain("send");
  });

  it("does not paste or restore over a newer user clipboard", () => {
    const { state, run } = fixture();
    state.onClipboard = () => { state.clipboardRevision++; };
    expect(() => run()).toThrow("LATCH_COMPOSER_UNVERIFIED");
    expect(state.actions).not.toContain("paste");
    expect(state.restored).toBe(0);
  });

  it("leaves a later clipboard change intact after the send", () => {
    const { state, run } = fixture();
    state.onPaste = () => { state.clipboardRevision++; };
    expect(run()).toBe("LATCH_SEND_ATTEMPTED");
    expect(state.restored).toBe(0);
  });

  it("never labels an attempted Send action as a pre-send refusal or retries it", () => {
    const { state, run } = fixture();
    state.sendThrows = true;
    expect(() => run()).toThrow("LATCH_SEND_UNVERIFIED");
    expect(state.actions.filter((action) => action === "send")).toHaveLength(1);
  });

  it("refuses unexpected sheets and disabled send controls", () => {
    for (const setup of [(s: ReturnType<typeof fixture>["state"]) => { s.modal = true; },
      (s: ReturnType<typeof fixture>["state"]) => { s.sendEnabled = false; }]) {
      const { state, run } = fixture();
      setup(state);
      expect(() => run()).toThrow(/LATCH_(RECIPIENT|COMPOSER)_UNVERIFIED/);
      expect(state.actions).not.toContain("send");
    }
  });

  it("bounds missing-window waits and refuses excessive AX trees", () => {
    const missing = fixture();
    missing.state.noWindow = true;
    expect(() => missing.run()).toThrow("LATCH_RECIPIENT_UNVERIFIED");
    expect(missing.state.now).toBeLessThan(31_000);
    const huge = fixture();
    huge.state.extra = Array.from({ length: 401 }, () => node("extra"));
    expect(() => huge.run()).toThrow("LATCH_RECIPIENT_UNVERIFIED");
    expect(huge.state.actions).not.toContain("send");
  });

  it("does not traverse message or sidebar history", () => {
    const { state, run } = fixture();
    state.extra = ["ChatMessagesTableView", "ChatListView_TableView"].map((id) => {
      const table = node(id, "AXTable");
      Object.defineProperty(table, "children", { get: () => { throw new Error("history must not be read"); } });
      return table;
    });
    expect(run()).toBe("LATCH_SEND_ATTEMPTED");
  });
});

class PasteboardItem {
  data = new Map<string, unknown>();
  get types() { return [...this.data.keys()]; }
  dataForType(type: string) { return this.data.get(type); }
  setDataForType(data: unknown, type: string) { this.data.set(type, data); return true; }
  setStringForType(data: string, type: string) { return this.setDataForType(data, type); }
}

function clipboardFixture() {
  const text = new PasteboardItem();
  text.data.set("public.utf8-plain-text", "user clipboard");
  text.data.set("public.rtf", Buffer.from("{rtf exact bytes}"));
  const image = new PasteboardItem();
  image.data.set("public.png", Buffer.from([0, 255, 1, 99]));
  image.data.set("custom.private-type", Buffer.from([18, 32]));
  const original = [text, image];
  const board = {
    items: original, changeCount: 7,
    get pasteboardItems() { return { count: this.items.length, objectAtIndex: (i: number) => this.items[i] }; },
    get clearContents() { this.items = []; return ++this.changeCount; },
    writeObjects(items: PasteboardItem[]) { this.items = items; this.changeCount++; return true; },
    stringForType(type: string) { return this.items[0]?.dataForType(type) ?? null; },
  };
  const dollar = Object.assign((value: unknown) => value, {
    NSPasteboard: { generalPasteboard: board },
    NSPasteboardItem: { alloc: { get init() { return new PasteboardItem(); } } },
    NSUUID: { UUID: { UUIDString: "one-message-clipboard-nonce" } },
  });
  const context = { $: dollar, ObjC: { import: () => {}, unwrap: (x: unknown) => x, deepUnwrap: (x: unknown) => x } };
  vm.runInNewContext(WHATSAPP_SCRIPT, context);
  const prepare = (context as unknown as { nativeWhatsAppClipboard(body: string): { current(): boolean; restore(): void } }).nativeWhatsAppClipboard;
  return { board, original, prepare };
}

describe("native clipboard lease", () => {
  it("preserves every item, type, and exact binary payload", () => {
    const { board, original, prepare } = clipboardFixture();
    const lease = prepare(ARGS[0]!);
    expect(board.stringForType("public.utf8-plain-text")).toBe(ARGS[0]);
    expect(lease.current()).toBe(true);
    lease.restore();
    expect(board.items.map((item) => [...item.data])).toEqual(original.map((item) => [...item.data]));
    expect(board.items[0]).not.toBe(original[0]);
  });

  it("does not replace a later user clipboard", () => {
    const { board, prepare } = clipboardFixture();
    const lease = prepare("approved message");
    const newer = new PasteboardItem();
    newer.setStringForType("new user copy", "public.utf8-plain-text");
    board.writeObjects([newer]);
    expect(lease.current()).toBe(false);
    lease.restore();
    expect(board.items).toEqual([newer]);
  });

  it("does not clear the clipboard when any original type cannot be captured", () => {
    const { board, original, prepare } = clipboardFixture();
    original[1]!.data.set("unavailable-promised-data", null);
    expect(() => prepare("approved message")).toThrow("clipboard cannot be preserved");
    expect(board.changeCount).toBe(7);
    expect(board.items).toBe(original);
  });

  it.each(["before", "after"])("restores the original data when writing throws %s accepting the payload", (when) => {
    const { board, original, prepare } = clipboardFixture();
    const write = board.writeObjects.bind(board);
    let first = true;
    board.writeObjects = (items) => {
      if (!first) return write(items);
      first = false;
      if (when === "after") write(items);
      throw new Error("pasteboard write exception");
    };
    expect(() => prepare("approved message")).toThrow("clipboard write failed");
    expect(board.items.map((item) => [...item.data])).toEqual(original.map((item) => [...item.data]));
  });

  it("does not restore over a user copy that occurs during a failed payload write", () => {
    const { board, prepare } = clipboardFixture();
    const newer = new PasteboardItem();
    newer.setStringForType("new user copy", "public.utf8-plain-text");
    const write = board.writeObjects.bind(board);
    board.writeObjects = () => { write([newer]); return false; };
    expect(() => prepare("approved message")).toThrow("clipboard write failed");
    expect(board.items).toEqual([newer]);
  });
});

function nativeAxFixture() {
  type RawNode = Record<string, unknown>;
  const phone: RawNode = { AXRole: "AXStaticText", AXDescription: "+1 555 123 4567" };
  const info: RawNode = { AXIdentifier: "contact-info-view-name-number-view", AXRole: "AXGroup", AXChildren: [
    { AXRole: "AXHeading", AXDescription: "arbitrary name" }, phone,
  ] };
  const composer: RawNode = { AXIdentifier: "ChatBar_ComposerTextView", AXRole: "AXTextArea", AXEnabled: true };
  const unrelated: RawNode = { AXRole: "AXStaticText", AXDescription: "15551234567" };
  const header: RawNode = { AXIdentifier: "NavigationBar_HeaderViewButton", AXRole: "AXButton", AXDescription: "contact label" };
  const history: RawNode = { AXIdentifier: "ChatMessagesTableView", AXRole: "AXTable" };
  Object.defineProperty(history, "AXChildren", { get: () => { throw new Error("message history was read"); } });
  const window: RawNode = { AXIdentifier: "SceneWindow", AXRole: "AXWindow", AXChildren: [composer, info, unrelated, history, header] };
  const app: RawNode = { AXWindows: [window], AXFocusedWindow: window, AXFocusedUIElement: composer };
  const running = { processIdentifier: 123 };
  const state = { valueError: 0 };
  const dollar = Object.assign((value: unknown) => value, {
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 1, firstObject: running }) },
    NSWorkspace: { sharedWorkspace: { frontmostApplication: running } },
    AXUIElementCreateApplication: () => app,
    AXUIElementSetMessagingTimeout: () => 0,
    AXUIElementCopyAttributeValue: (ref: RawNode, key: string, out: Record<number, unknown>) => {
      if (ref === composer && key === "AXValue" && state.valueError) return state.valueError;
      if (!(key in ref)) return -25212;
      out[0] = ref[key];
      return 0;
    },
    AXUIElementGetAttributeValueCount: (ref: RawNode, key: string, out: Record<number, unknown>) => {
      if (!(key in ref)) return -25205;
      out[0] = (ref[key] as unknown[]).length;
      return 0;
    },
    AXUIElementCopyAttributeValues: (ref: RawNode, key: string, start: number, count: number, out: Record<number, unknown>) => {
      out[0] = (ref[key] as unknown[]).slice(start, start + count);
      return 0;
    },
  });
  const context = {
    $: dollar, Ref: () => ({}), Application: () => ({}),
    ObjC: { import: () => {}, bindFunction: () => {}, unwrap: (x: unknown) => x, deepUnwrap: (x: unknown) => x },
  };
  vm.runInNewContext(WHATSAPP_SCRIPT, context);
  const adapter = (context as unknown as { nativeWhatsAppAdapter(): WhatsAppNativeAdapter }).nativeWhatsAppAdapter();
  return { adapter, state };
}

describe("native AX adapter", () => {
  it("uses a secondary label description, normalizes an absent composer value, and prunes history", () => {
    const { adapter } = nativeAxFixture();
    const snapshot = adapter.snapshot();
    const [composer, info, unrelated, history, header] = snapshot.roots[0]!.children;
    expect(composer?.value).toBe("");
    expect(info?.children[1]?.value).toBe("+1 555 123 4567");
    expect(unrelated?.value).toBeNull();
    expect(history?.children).toEqual([]);
    expect(header?.value).toBe("contact label");
  });

  it.each([-25202, -25204])("classifies transient AX status %s without inventing an empty composer", (status) => {
    const { adapter, state } = nativeAxFixture();
    state.valueError = status;
    expect(() => adapter.snapshot()).toThrow(`LATCH_AX_TRANSIENT:${status}`);
  });

  it("does not treat an unsupported composer AXValue as a known empty value", () => {
    const { adapter, state } = nativeAxFixture();
    state.valueError = -25205;
    expect(() => adapter.snapshot()).toThrow("AX attribute unsupported");
  });

  it("reports other native read failures with a numeric diagnostic instead of retrying", () => {
    const { adapter, state } = nativeAxFixture();
    state.valueError = -25211;
    expect(() => adapter.snapshot()).toThrow("AX read failed:-25211");
  });
});
