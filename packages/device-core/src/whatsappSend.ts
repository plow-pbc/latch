/** The controller is embedded verbatim in the fixed JXA script and exercised with fixture AX trees. */
export interface WhatsAppAxNode {
  ref: unknown;
  identifier: string;
  role: string;
  value: string | null;
  enabled: boolean;
  children: WhatsAppAxNode[];
}

export interface WhatsAppAxSnapshot {
  frontmost: boolean;
  focusedWindow: WhatsAppAxNode | null;
  focusedElement: WhatsAppAxNode | null;
  roots: WhatsAppAxNode[];
}

export interface WhatsAppNativeAdapter {
  now(): number;
  pause(): void;
  openChat(url: string): void;
  snapshot(): WhatsAppAxSnapshot;
  sameElement(a: WhatsAppAxNode, b: WhatsAppAxNode): boolean;
  press(node: WhatsAppAxNode): void;
  focus(node: WhatsAppAxNode): void;
  escape(): void;
  paste(): void;
  clipboard(body: string): { current(): boolean; restore(): void };
}

function whatsappAxFind(roots: WhatsAppAxNode[], identifier: string | null, role?: string): WhatsAppAxNode[] {
  const found: WhatsAppAxNode[] = [];
  const pending = roots.map((node) => ({ node, depth: 0 }));
  let visited = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++visited > 400 || depth > 20) throw new Error("AX traversal limit");
    if ((identifier === null || node.identifier === identifier) && (!role || node.role === role)) found.push(node);
    if (node.identifier === "ChatMessagesTableView" || node.identifier === "ChatListView_TableView") continue;
    for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
  }
  return found;
}

/** Only the secondary phone field of the observed named-contact layout is proof. */
function whatsappInfoPhone(info: WhatsAppAxNode): string | null {
  if (info.children.length !== 2) return null;
  const [heading, secondary] = info.children;
  const headingRole = heading?.role === "AXGroup" && heading.children.length === 1
    ? heading.children[0]?.role : heading?.role;
  if (headingRole !== "AXHeading" || secondary?.role !== "AXStaticText") return null;
  const value = secondary.value?.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  if (!value || !/^\+?[0-9][0-9 ().\-\u00a0\u202f]*[0-9]$/.test(value)) return null;
  const digits = value.replace(/[ ().\-\u00a0\u202f]/g, "").replace(/^\+/, "");
  return /^[1-9][0-9]{5,14}$/.test(digits) ? digits : null;
}

function whatsappSendController(adapter: WhatsAppNativeAdapter, argv: string[]): string {
  let cause = "LATCH_RECIPIENT_UNVERIFIED";
  let attempted = false;
  let failure = "";
  let clipboard: ReturnType<WhatsAppNativeAdapter["clipboard"]> | null = null;
  const deadline = adapter.now() + 30_000;
  let main: WhatsAppAxNode | null = null;

  function unique(snapshot: WhatsAppAxSnapshot, id: string): WhatsAppAxNode | null {
    const nodes = whatsappAxFind(snapshot.roots, id);
    if (nodes.length > 1) throw new Error("ambiguous AX identity");
    return nodes[0] ?? null;
  }

  function read(): WhatsAppAxSnapshot {
    if (adapter.now() > deadline) throw new Error("AX deadline");
    const snapshot = adapter.snapshot();
    if (main && (!snapshot.frontmost || !unique(snapshot, "SceneWindow") ||
      !adapter.sameElement(main, unique(snapshot, "SceneWindow")!))) throw new Error("window changed");
    return snapshot;
  }

  function waitFor<T>(select: (snapshot: WhatsAppAxSnapshot) => T | null): T {
    for (;;) {
      let snapshot: WhatsAppAxSnapshot;
      try {
        snapshot = read();
      } catch (error) {
        if (!/^LATCH_AX_TRANSIENT:-2520[24]$/.test(String((error as Error)?.message))) throw error;
        adapter.pause();
        continue;
      }
      const value = select(snapshot);
      if (value !== null) return value;
      adapter.pause();
    }
  }

  function active(snapshot: WhatsAppAxSnapshot): void {
    if (!main || !snapshot.frontmost || !snapshot.focusedWindow ||
      !adapter.sameElement(main, snapshot.focusedWindow)) throw new Error("window is not active");
    if (unique(snapshot, "contact-info-view-name-number-view")) throw new Error("info is still open");
    if (whatsappAxFind(snapshot.roots, null, "AXSheet").length) throw new Error("modal is open");
  }

  function readyMain(snapshot: WhatsAppAxSnapshot): WhatsAppAxNode | null {
    const candidate = unique(snapshot, "SceneWindow");
    if (!candidate || !snapshot.frontmost || !snapshot.focusedWindow ||
      !adapter.sameElement(candidate, snapshot.focusedWindow)) return null;
    if (candidate.role !== "AXWindow") throw new Error("unexpected window role");
    if (whatsappAxFind(snapshot.roots, null, "AXSheet").length ||
      unique(snapshot, "contact-info-view-name-number-view")) return null;
    const header = unique(snapshot, "NavigationBar_HeaderViewButton");
    const field = unique(snapshot, "ChatBar_ComposerTextView");
    if (!header?.enabled || !field?.enabled) return null;
    if (header.role !== "AXButton" || field.role !== "AXTextArea") throw new Error("unexpected control role");
    return candidate;
  }

  function control(snapshot: WhatsAppAxSnapshot, id: string, role: string): WhatsAppAxNode {
    const node = unique(snapshot, id);
    const scoped = whatsappAxFind([unique(snapshot, "SceneWindow")!], id);
    if (!node || node.role !== role || scoped.length !== 1 || !adapter.sameElement(node, scoped[0]!)) {
      throw new Error("control is outside the expected layout");
    }
    return node;
  }

  function composer(snapshot: WhatsAppAxSnapshot, body: string): WhatsAppAxNode {
    active(snapshot);
    const node = control(snapshot, "ChatBar_ComposerTextView", "AXTextArea");
    if (!node || node.value !== body || !node.enabled) throw new Error("composer changed");
    if (body === "" && unique(snapshot, "ChatBar_SendButton")?.enabled) throw new Error("draft model is not empty");
    return node;
  }

  function conversation(snapshot: WhatsAppAxSnapshot) {
    active(snapshot);
    const header = control(snapshot, "NavigationBar_HeaderViewButton", "AXButton");
    const field = control(snapshot, "ChatBar_ComposerTextView", "AXTextArea");
    if (!header.enabled || !field.enabled || !header.value?.trim()) throw new Error("conversation controls unavailable");
    return { header, field };
  }

  function sameConversation(snapshot: WhatsAppAxSnapshot, previous: ReturnType<typeof conversation>): void {
    const next = conversation(snapshot);
    // The label is a continuity check after phone proof, never recipient identity.
    if (next.header.value !== previous.header.value || !adapter.sameElement(next.header, previous.header) ||
      !adapter.sameElement(next.field, previous.field)) throw new Error("conversation changed");
  }

  function confirmPhone(phone: string) {
    const before = read();
    const controls = conversation(before);
    adapter.press(controls.header);
    waitFor((snapshot) => {
      const info = unique(snapshot, "contact-info-view-name-number-view");
      if (!info) return null;
      const sheets = whatsappAxFind(snapshot.roots, null, "AXSheet");
      if (sheets.length !== 1 || whatsappAxFind(sheets, "contact-info-view-name-number-view").length !== 1) {
        throw new Error("unexpected info sheet");
      }
      if (whatsappInfoPhone(info) !== phone) throw new Error("recipient does not match");
      return info;
    });
    // Escape is only a navigation action, after proving the visible info pane.
    const shown = read();
    if (whatsappInfoPhone(unique(shown, "contact-info-view-name-number-view")!) !== phone) {
      throw new Error("recipient changed");
    }
    adapter.escape();
    const closed = waitFor((snapshot) => readyMain(snapshot) ? snapshot : null);
    sameConversation(closed, controls);
    return controls;
  }

  try {
    const [body, url, recipient] = argv;
    if (typeof body !== "string" || !body || !/^[1-9][0-9]{5,14}@s\.whatsapp\.net$/.test(recipient ?? "")) {
      throw new Error("unsupported recipient");
    }
    const phone = recipient!.slice(0, -"@s.whatsapp.net".length);
    if (url !== `whatsapp://send?phone=${phone}`) throw new Error("URL disagrees with recipient");
    adapter.openChat(url);
    main = waitFor(readyMain);
    const original = confirmPhone(phone);
    cause = "LATCH_COMPOSER_UNVERIFIED";
    const empty = composer(read(), "");
    clipboard = adapter.clipboard(body);
    adapter.focus(empty);
    const focused = read();
    sameConversation(focused, original);
    const target = composer(focused, "");
    if (!focused.focusedElement || !adapter.sameElement(target, focused.focusedElement) || !clipboard.current()) {
      throw new Error("paste target or clipboard changed");
    }
    adapter.paste();
    waitFor((snapshot) => {
      active(snapshot);
      const field = unique(snapshot, "ChatBar_ComposerTextView");
      if (field?.value === "") return null;
      return composer(snapshot, body);
    });
    cause = "LATCH_RECIPIENT_UNVERIFIED";
    sameConversation(read(), original);
    const confirmed = confirmPhone(phone);
    cause = "LATCH_COMPOSER_UNVERIFIED";
    const ready = read();
    sameConversation(ready, confirmed);
    composer(ready, body);
    const send = control(ready, "ChatBar_SendButton", "AXButton");
    if (!send?.enabled) throw new Error("missing send control");
    attempted = true;
    adapter.press(send);
  } catch {
    failure = attempted ? "LATCH_SEND_UNVERIFIED" : cause;
  } finally {
    try {
      clipboard?.restore();
    } catch {
      failure = attempted ? "LATCH_SEND_UNVERIFIED" : "LATCH_COMPOSER_UNVERIFIED";
    }
  }
  if (failure) throw new Error(failure);
  return "LATCH_SEND_ATTEMPTED";
}

// Fixed native adapter. No message body or recipient is interpolated into source.
const WHATSAPP_NATIVE = String.raw`
function nativeWhatsAppClipboard(body) {
  ObjC.import('AppKit');
  var board = $.NSPasteboard.generalPasteboard;
  var originalCount = Number(board.changeCount);
  var saved = [];
  var items = board.pasteboardItems;
  for (var i = 0; i < Number(items.count); i++) {
    var item = items.objectAtIndex(i);
    var copy = $.NSPasteboardItem.alloc.init;
    var types = ObjC.deepUnwrap(item.types);
    for (var j = 0; j < types.length; j++) {
      var data = item.dataForType($(types[j]));
      if (!data || !copy.setDataForType(data, $(types[j]))) throw new Error('clipboard cannot be preserved');
    }
    saved.push(copy);
  }
  if (Number(board.changeCount) !== originalCount) throw new Error('clipboard changed');
  var token = ObjC.unwrap($.NSUUID.UUID.UUIDString);
  var marker = 'org.plow.latch.message-send';
  var payload = $.NSPasteboardItem.alloc.init;
  if (!payload.setStringForType($(body), $('public.utf8-plain-text')) ||
      !payload.setStringForType($(token), $(marker))) throw new Error('clipboard preparation failed');
  var ownedCount = null;
  function current() {
    return ownedCount !== null && Number(board.changeCount) === ownedCount &&
      ObjC.unwrap(board.stringForType($(marker))) === token;
  }
  function restore() {
    if (!current()) return;
    board.clearContents;
    if (saved.length && !board.writeObjects($(saved))) throw new Error('clipboard restoration failed');
  }
  board.clearContents;
  ownedCount = Number(board.changeCount);
  try {
    if (!board.writeObjects($([payload]))) throw new Error('clipboard write failed');
  } catch (error) {
    // A write can throw after clearing or after accepting our marked payload.
    // Restore only when the unchanged clear count or our marker proves ownership.
    if (Number(board.changeCount) === ownedCount || ObjC.unwrap(board.stringForType($(marker))) === token) {
      board.clearContents;
      if (saved.length && !board.writeObjects($(saved))) throw new Error('clipboard restoration failed');
    }
    throw new Error('clipboard write failed');
  }
  ownedCount = Number(board.changeCount);
  return { current: current, restore: restore };
}

function nativeWhatsAppAdapter() {
  ObjC.import('Cocoa');
  ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['unsigned int']]);
  ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id*']]);
  ObjC.bindFunction('AXUIElementGetAttributeValueCount', ['int', ['id', 'id', 'long*']]);
  ObjC.bindFunction('AXUIElementCopyAttributeValues', ['int', ['id', 'id', 'long', 'long', 'id*']]);
  ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
  ObjC.bindFunction('AXUIElementPerformAction', ['int', ['id', 'id']]);
  ObjC.bindFunction('AXUIElementSetMessagingTimeout', ['int', ['id', 'float']]);
  var process = null;
  var appElement = null;
  var system = Application('System Events');

  function readError(status) {
    if (status === -25202 || status === -25204) throw new Error('LATCH_AX_TRANSIENT:' + status);
    throw new Error('AX read failed:' + status);
  }

  function attach() {
    var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('net.whatsapp.WhatsApp');
    if (Number(apps.count) !== 1) throw new Error('ambiguous WhatsApp process');
    process = apps.firstObject;
    appElement = $.AXUIElementCreateApplication(process.processIdentifier);
    if ($.AXUIElementSetMessagingTimeout(appElement, 1) !== 0) throw new Error('AX timeout unavailable');
  }

  function attribute(ref, name, requireSupported) {
    var result = Ref();
    var status = $.AXUIElementCopyAttributeValue(ref, $(name), result);
    if (status === -25205 && requireSupported) throw new Error('AX attribute unsupported');
    if (status === -25205 || status === -25212) return null;
    if (status !== 0) readError(status);
    return result[0];
  }
  function scalar(ref, name, requireSupported) {
    var value = attribute(ref, name, requireSupported);
    return value === null ? null : ObjC.unwrap(value);
  }
  function children(ref, name, remaining) {
    var count = Ref();
    var status = $.AXUIElementGetAttributeValueCount(ref, $(name), count);
    if (status === -25205 || status === -25212) return [];
    if (status !== 0) readError(status);
    if (count[0] > remaining) throw new Error('AX traversal limit');
    if (!count[0]) return [];
    var result = Ref();
    status = $.AXUIElementCopyAttributeValues(ref, $(name), 0, count[0], result);
    if (status !== 0) readError(status);
    return ObjC.deepUnwrap(result[0]);
  }
  function reference(ref) {
    return ref ? { ref: ref } : null;
  }
  function snapshot() {
    if (!process || !appElement) attach();
    var remaining = 400;
    var expires = Date.now() + 5000;
    function walk(ref, depth, parentIdentifier) {
      if (--remaining < 0 || depth > 20 || Date.now() > expires) throw new Error('AX traversal limit');
      var identifier = scalar(ref, 'AXIdentifier') || '';
      var role = scalar(ref, 'AXRole') || '';
      var value = scalar(ref, 'AXValue', identifier === 'ChatBar_ComposerTextView');
      // Catalyst exposes some labels through Description/Title. This fallback
      // belongs only to a static child of the semantic identity container.
      if (value === null && ((parentIdentifier === 'contact-info-view-name-number-view' && role === 'AXStaticText') ||
          identifier === 'NavigationBar_HeaderViewButton')) {
        value = scalar(ref, 'AXDescription');
        if (value === null) value = scalar(ref, 'AXTitle');
      }
      if (value === null && identifier === 'ChatBar_ComposerTextView') value = '';
      var result = { ref: ref, identifier: identifier, role: role,
        value: typeof value === 'string' ? value : null,
        enabled: scalar(ref, 'AXEnabled') === true, children: [] };
      if (identifier !== 'ChatMessagesTableView' && identifier !== 'ChatListView_TableView') {
        result.children = children(ref, 'AXChildren', remaining).map(function (child) { return walk(child, depth + 1, identifier); });
      }
      return result;
    }
    var roots = children(appElement, 'AXWindows', 4).map(function (window) { return walk(window, 0, ''); });
    return { roots: roots,
      frontmost: Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) === Number(process.processIdentifier),
      focusedWindow: reference(attribute(appElement, 'AXFocusedWindow')),
      focusedElement: reference(attribute(appElement, 'AXFocusedUIElement')) };
  }
  return {
    now: function () { return Date.now(); },
    pause: function () { delay(0.15); },
    openChat: function (url) {
      if (!$.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString($(url)))) throw new Error('WhatsApp URL refused');
      var until = Date.now() + 5000;
      while (Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier('net.whatsapp.WhatsApp').count) === 0) {
        if (Date.now() > until) throw new Error('WhatsApp did not open');
        delay(0.15);
      }
      attach();
      if (!process.activateWithOptions($.NSApplicationActivateIgnoringOtherApps)) throw new Error('WhatsApp could not activate');
    },
    snapshot: snapshot,
    sameElement: function (a, b) { return Boolean($.CFEqual(a.ref, b.ref)); },
    press: function (node) {
      if ($.AXUIElementPerformAction(node.ref, $('AXPress')) !== 0) throw new Error('AX press failed');
    },
    focus: function (node) {
      if ($.AXUIElementSetAttributeValue(node.ref, $('AXFocused'), $.kCFBooleanTrue) !== 0) throw new Error('AX focus failed');
    },
    escape: function () { system.keyCode(53); },
    paste: function () { system.keystroke('v', { using: 'command down' }); },
    clipboard: nativeWhatsAppClipboard
  };
}
`;

export const WHATSAPP_SCRIPT = [
  whatsappAxFind.toString(), whatsappInfoPhone.toString(), whatsappSendController.toString(), WHATSAPP_NATIVE,
  "function run(argv) { return whatsappSendController(nativeWhatsAppAdapter(), argv); }",
].join("\n");
