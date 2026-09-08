/**
 * The page-side scripts, as pure functions — no Python, no browser. These used
 * to be lifted out of `"""…"""` string literals and eval'd; now they are real
 * functions (so Playwright actually CALLS them — see pageScripts.ts), and the
 * tests call them directly against stub nodes.
 *
 * This tier tests the ALGORITHMS. That a real browser actually invokes them and
 * masks the field is maskReal.integration.test.ts — the coverage that would have
 * caught the string-vs-function bug, which this tier structurally cannot.
 */
import { describe, expect, it } from "vitest";
import {
  DOC_TOKEN_JS,
  FIELD_JS,
  HELD_MATCHES_JS,
  KEYS_DROPPED_JS,
  MASK_JS,
  NOTHING_LANDED_JS,
  TYPEABLE_JS,
  UNMASK_JS,
  VALUE_SNAPSHOT_JS,
} from "../src/pageScripts.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("which nodes take typing", () => {
  const input = (type: string, extra: Record<string, unknown> = {}) => ({
    tagName: "INPUT", type, disabled: false, readOnly: false,
    getAttribute: (k: string) => (k === "type" ? type : null), ...extra,
  });
  const textarea = (extra: Record<string, unknown> = {}) => ({
    tagName: "TEXTAREA", type: "textarea", disabled: false, readOnly: false,
    getAttribute: () => null, ...extra,
  });
  const element = (tagName: string, extra: Record<string, unknown> = {}) => ({
    tagName, getAttribute: () => null, ...extra,
  });

  it.each([
    { what: "a text field", el: input("text"), kind: "single-line" },
    { what: "an email field", el: input("email"), kind: "single-line" },
    { what: "a password field", el: input("password"), kind: "single-line" },
    { what: "a search box", el: input("search"), kind: "single-line" },
    { what: "a phone field", el: input("tel"), kind: "single-line" },
    { what: "a url field", el: input("url"), kind: "single-line" },
    { what: "a number field", el: input("number"), kind: "single-line" },
    { what: "an input with no type attribute", el: input("text", { getAttribute: () => null }), kind: "single-line" },
    { what: "a capitalised type attribute", el: input("password", { getAttribute: () => "Password" }), kind: "single-line" },
    { what: "a textarea", el: textarea(), kind: "multiline" },
    { what: "a checkbox", el: input("checkbox"), kind: "" },
    { what: "a radio button", el: input("radio"), kind: "" },
    { what: "a file picker", el: input("file"), kind: "" },
    { what: "a submit button", el: input("submit"), kind: "" },
    { what: "a hidden input", el: input("hidden"), kind: "" },
    { what: "a date input", el: input("date"), kind: "" },
    { what: "a range slider", el: input("range"), kind: "" },
    { what: "a read-only input", el: input("password", { readOnly: true }), kind: "" },
    { what: "a disabled input", el: input("password", { disabled: true }), kind: "" },
    { what: "a read-only textarea", el: textarea({ readOnly: true }), kind: "" },
    { what: "a disabled textarea", el: textarea({ disabled: true }), kind: "" },
    { what: "a select", el: element("SELECT", { value: "", disabled: false }), kind: "select" },
    { what: "a disabled select", el: element("SELECT", { value: "", disabled: true }), kind: "" },
    { what: "a multi-select", el: element("SELECT", { value: "", disabled: false, multiple: true }), kind: "" },
    { what: "an iframe", el: element("IFRAME"), kind: "" },
    { what: "a span", el: element("SPAN"), kind: "" },
    { what: "a contenteditable div", el: element("DIV", { getAttribute: (k: string) => (k === "contenteditable" ? "true" : null) }), kind: "" },
  ])("$what: kind=$kind", ({ el, kind }) => {
    expect(TYPEABLE_JS(el as any)).toBe(kind);
  });
});

describe("whether the keys landed", () => {
  it.each([
    { what: "an empty field", el: { value: "" }, wanted: "hunter2", fallback: true },
    { what: "a truncated field", el: { value: "hunt" }, wanted: "hunter2", fallback: true },
    { what: "a field holding the value", el: { value: "hunter2" }, wanted: "hunter2", fallback: false },
    { what: "a card number the field spaced out", el: { value: "4111 1111" }, wanted: "41111111", fallback: false },
    { what: "a value the field upper-cased", el: { value: "HUNTER2" }, wanted: "hunter2", fallback: false },
    { what: "a contenteditable holding the value", el: { textContent: "hunter2" }, wanted: "hunter2", fallback: false },
    { what: "an empty contenteditable", el: { textContent: "" }, wanted: "hunter2", fallback: true },
  ])("$what needs the assignment: $fallback", ({ el, wanted, fallback }) => {
    expect(KEYS_DROPPED_JS(el as any, wanted)).toBe(fallback);
  });
});

describe("whether a fill that failed left anything behind", () => {
  it.each([
    { what: "an input", el: { value: "1 Elm" } },
    { what: "a contenteditable", el: { textContent: "1 Elm" } },
  ])("captures what $what was holding", ({ el }) => {
    expect(VALUE_SNAPSHOT_JS(el as any)).toBe("1 Elm");
  });

  it.each([
    { what: "an input still holding what it held", el: { value: "1 Elm" }, before: "1 Elm", nothing: true },
    { what: "an emptied input", el: { value: "" }, before: "1 Elm", nothing: true },
    { what: "an input holding more", el: { value: "1 Elm Sec" }, before: "1 Elm", nothing: false },
    { what: "a contenteditable still holding what it held", el: { textContent: "1 Elm" }, before: "1 Elm", nothing: true },
    { what: "an emptied contenteditable", el: { textContent: "" }, before: "1 Elm", nothing: true },
    { what: "a contenteditable holding more", el: { textContent: "1 Elm Sec" }, before: "1 Elm", nothing: false },
  ])("$what: nothing landed is $nothing", ({ el, before, nothing }) => {
    expect(NOTHING_LANDED_JS(el as any, before)).toBe(nothing);
  });
});

interface StubEl {
  attrs: Record<string, string>;
  style: { props: Record<string, string>; setProperty(k: string, v: string): void; removeProperty(k: string): void; webkitTextSecurity?: string };
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  hasAttribute(k: string): boolean;
  getAttribute(k: string): string | null;
  ownerDocument: StubDoc;
  tagName: string;
  type: string;
  name: string;
  id: string;
  labels: never[];
  value: string;
  options: never[];
}
interface StubDoc {
  styles: { id: string; textContent: string }[];
  head: { appendChild(node: { id: string; textContent: string }): void };
  getElementById(id: string): { id: string } | null;
  createElement(tag: string): { id: string; textContent: string };
  defaultView: { getComputedStyle(el: StubEl): { getPropertyValue(p: string): string } };
}

function stubPage(opts: { stylesheets?: boolean; inlineProperties?: boolean } = {}): {
  doc: StubDoc;
  el: () => StubEl;
} {
  const stylesheets = opts.stylesheets ?? true;
  const inlineProperties = opts.inlineProperties ?? true;
  const doc = {
    styles: [] as { id: string; textContent: string }[],
    head: { appendChild: (node: { id: string; textContent: string }) => void doc.styles.push(node) },
    getElementById: (id: string) => doc.styles.find((s) => s.id === id) ?? null,
    createElement: () => ({ id: "", textContent: "" }),
    defaultView: {
      getComputedStyle: (el: StubEl) => ({
        getPropertyValue: (prop: string) => {
          if (prop !== "-webkit-text-security") return "";
          if (inlineProperties && el.style.props[prop]) return el.style.props[prop];
          const sheet = doc.styles.some((s) => s.id === "domo-secret-style");
          return stylesheets && sheet && "data-domo-secret" in el.attrs ? "disc" : "";
        },
      }),
    },
  } as StubDoc;
  return {
    doc,
    el: () => {
      const attrs: Record<string, string> = {};
      const props: Record<string, string> = {};
      return {
        attrs, tagName: "INPUT", type: "text", name: "cc-number", id: "", labels: [], value: "", options: [],
        style: {
          props,
          setProperty: (k: string, v: string) => { if (inlineProperties) props[k] = v; },
          removeProperty: (k: string) => { delete props[k]; },
        },
        setAttribute(k: string, v: string) { attrs[k] = v; },
        removeAttribute(k: string) { delete attrs[k]; },
        hasAttribute: (k: string) => k in attrs,
        getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
        ownerDocument: doc,
      } as StubEl;
    },
  };
}

describe("the mark the page ends up carrying", () => {
  it("puts the attribute the forms scan looks for on the element, and nothing else", () => {
    const page = stubPage();
    const el = page.el();
    expect(MASK_JS(el as any)).toBe("stylesheet");
    expect(el.attrs).toEqual({ "data-domo-secret": "" });
    expect(page.doc.styles.length).toBe(1);
    expect(el.style.props).toEqual({});
  });

  it("injects the stylesheet once across repeated fills", () => {
    const page = stubPage();
    expect(MASK_JS(page.el() as any)).toBe("stylesheet");
    expect(MASK_JS(page.el() as any)).toBe("stylesheet");
    expect(page.doc.styles.length).toBe(1);
    expect(page.doc.styles[0].textContent).toBe("[data-domo-secret]{-webkit-text-security:disc}");
  });

  it("falls back to the element's own style when a CSP blocks the stylesheet", () => {
    const page = stubPage({ stylesheets: false });
    const el = page.el();
    expect(MASK_JS(el as any)).toBe("inline");
    expect(el.attrs).toEqual({ "data-domo-secret": "" });
    expect(el.style.props["-webkit-text-security"]).toBe("disc");
  });

  it("takes its own tag back off when the mark did not take", () => {
    const page = stubPage({ stylesheets: false, inlineProperties: false });
    const el = page.el();
    expect(MASK_JS(el as any)).toBe("unmasked");
    expect(el.attrs).toEqual({});
    expect(el.style.props).toEqual({});
  });

  it("leaves the tag alone on a field that was already masked", () => {
    const page = stubPage({ stylesheets: false, inlineProperties: false });
    const el = page.el();
    el.setAttribute("data-domo-secret", "");
    expect(MASK_JS(el as any)).toBe("unmasked");
    expect(el.attrs).toEqual({ "data-domo-secret": "" });
  });

  it("clears the mark and the fallback when a node is reused for a visible field", () => {
    const page = stubPage({ stylesheets: false });
    const el = page.el();
    MASK_JS(el as any);
    UNMASK_JS(el as any);
    expect(el.attrs).toEqual({});
    expect(el.style.props).toEqual({});
  });

  it("lets the forms scan report a cleared node normally again", () => {
    // FIELD_JS reads the global `document`; inject a stub around the call.
    const page = stubPage();
    const el = page.el();
    MASK_JS(el as any);
    el.value = "jon@example.com";
    const scan = (): { value: string; secret: boolean; filled: boolean }[] => {
      (globalThis as any).document = { querySelectorAll: () => [el] };
      try {
        return FIELD_JS() as any;
      } finally {
        delete (globalThis as any).document;
      }
    };
    const [masked] = scan();
    expect(masked.secret).toBe(true);
    expect(masked.value).toBe("");

    UNMASK_JS(el as any);
    const [plain] = scan();
    expect(plain.secret).toBe(false);
    expect(plain.value).toBe("jon@example.com");
  });
});

describe("what a select is holding", () => {
  // An option's label is what Playwright matched on; it falls back to the text
  // in the browser, and an explicit label attribute wins over it.
  const select = (value: string, label: string, text = label) => ({
    tagName: "SELECT", value,
    selectedOptions: [{ label, text }],
  });
  it.each([
    { what: "matches by value", el: select("11", "November"), wanted: "11", held: true },
    { what: "matches by label", el: select("11", "November"), wanted: "November", held: true },
    { what: "matches by label when the text differs", el: select("11", "November", "Nov"), wanted: "November", held: true },
    { what: "misses on another month", el: select("11", "November"), wanted: "May", held: false },
  ])("$what", ({ el, wanted, held }) => {
    expect(HELD_MATCHES_JS(el as any, wanted)).toBe(held);
  });
});

describe("a field that reformats what it was given", () => {
  const field = (value: string) => ({ tagName: "INPUT", value });
  it.each([
    { what: "a 2FA code the page hyphenates", wanted: "123456", held: "123-456", ok: true },
    { what: "a card number the page groups", wanted: "4111111111111111", held: "4111 1111 1111 1111", ok: true },
    { what: "a date the page slashes", wanted: "1226", held: "12/26", ok: true },
    { what: "a phone the page brackets", wanted: "4155550123", held: "(415) 555-0123", ok: true },
    { what: "a phone the page prefixed with a country code", wanted: "4155550123", held: "+1 (415) 555-0123", ok: false },
    { what: "a value the page left alone", wanted: "hunter2", held: "hunter2", ok: true },
    { what: "a field that dropped a character", wanted: "123456", held: "12345", ok: false },
    { what: "a field that added a digit", wanted: "123456", held: "1234567", ok: false },
    { what: "a field that ate a space out of a name", wanted: "Jon Doe", held: "JonDoe", ok: false },
    { what: "a field that appended punctuation that is not formatting", wanted: "hunter2", held: "hunter2!", ok: false },
    { what: "a field showing its own mask", wanted: "123456", held: "••••56", ok: false },
    { what: "a field that reordered the digits", wanted: "123456", held: "654-321", ok: false },
    { what: "a field that kept a separator after a clear", wanted: "", held: "-", ok: false },
    { what: "a field that is genuinely empty", wanted: "", held: "", ok: true },
    { what: "a passphrase with an emoji the page spaced out", wanted: "a\u{1F600}b", held: "a \u{1F600} b", ok: true },
  ])("$what", ({ wanted, held, ok }) => {
    expect(HELD_MATCHES_JS(field(held) as any, wanted)).toBe(ok);
  });
});

describe("which document this is", () => {
  // The token decides when the concealed-field ledger is emptied, and the
  // ledger is what refuses `eval`. So the property has to survive an agent
  // that has already been allowed to run one expression in this page.
  const inPage = <T>(body: () => T): T => {
    (globalThis as any).window = {};
    try {
      return body();
    } finally {
      delete (globalThis as any).window;
    }
  };

  // Identity is what cannot change. Arrival order is not checkable at the
  // moment of use — an expression the agent ran earlier can open a popup and
  // plant a token in it before this ever looks — so anything still able to
  // change is restamped, whoever left it there.
  it.each([
    { what: "nothing is there yet", planted: undefined },
    { what: "a token left assignable", planted: { value: "planted", configurable: true, writable: true } },
    { what: "a token left deletable", planted: { value: "planted", configurable: true } },
    { what: "an accessor free to answer differently each time",
      planted: { get: () => "planted", configurable: true } },
  ])("mints its own when $what", ({ planted }) => {
    inPage(() => {
      const w = (globalThis as any).window;
      if (planted !== undefined) Object.defineProperty(w, "__domoDocumentToken", planted);
      const token = DOC_TOKEN_JS();
      expect(token).not.toBe("planted");
      expect(token).not.toBe("");
      // And it is stable from then on, which is the whole property.
      expect(DOC_TOKEN_JS()).toBe(token);
    });
  });

  // A non-configurable ACCESSOR is the one shape that cannot be replaced by
  // anything, ever, in either of its forms. Restamping throws, so the script
  // must not try to carry on: "" says the document has no identity worth
  // stating, and the server declines to reason from it rather than trusting a
  // planted answer.
  it.each([
    { what: "a getter", planted: { get: () => "planted", configurable: false } },
    { what: "a setter", planted: { set: () => {}, configurable: false } },
    // Immutable, so it cannot be restamped — and still not identity. NaN reads
    // as a different document on every look, which would empty the ledger
    // before every action; the rest are simply not what this ever writes.
    { what: "a value unequal to itself", planted: { value: NaN } },
    { what: "a value that is not a string", planted: { value: 7 } },
    { what: "the empty string this keeps for a document it cannot name",
      planted: { value: "" } },
    // The ledger keys are `token:selector`, split at the first colon.
    { what: "a value carrying the separator the ledger keys on",
      planted: { value: "fixed:token" } },
  ])("states no identity at all when the name is held against it by $what", ({ planted }) => {
    inPage(() => {
      Object.defineProperty((globalThis as any).window, "__domoDocumentToken", planted);
      expect(DOC_TOKEN_JS()).toBe("");
    });
  });

  it("keeps a token that was already unchangeable", () => {
    inPage(() => {
      const w = (globalThis as any).window;
      // Nothing can forge a CHANGE out of this, which is all the ledger asks
      // of it — so restamping would cost a document its identity for nothing.
      Object.defineProperty(w, "__domoDocumentToken", { value: "fixed" });
      expect(DOC_TOKEN_JS()).toBe("fixed");
    });
  });

  it("cannot be deleted or overwritten by anything running in the page", () => {
    inPage(() => {
      const stamped = DOC_TOKEN_JS();
      const w = (globalThis as any).window;
      // What an earlier `eval` would reach for: drop the property, or replace
      // it, so the next look reads as a new document and drops the ledger with it.
      // Through `new Function`, because an eval'd expression runs SLOPPY — and
      // sloppy is where these fail quietly rather than throwing, which is the
      // path worth proving.
      expect(new Function("w", "return delete w.__domoDocumentToken")(w)).toBe(false);
      new Function("w", "w.__domoDocumentToken = 'forged'")(w);
      // This one throws either way.
      expect(() => Object.defineProperty(w, "__domoDocumentToken", { value: "forged" })).toThrow();
      expect(DOC_TOKEN_JS()).toBe(stamped);
    });
  });
});
