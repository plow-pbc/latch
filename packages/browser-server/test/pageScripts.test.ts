/**
 * The page-side scripts, run as the page runs them — no Python, no browser. These
 * used to be lifted out of server.py's `"""…"""` literals by `loadScript`; now
 * they are TS exports, so the tests evaluate them directly. This is the other
 * half of the masking guarantee (the fill BRANCH is fillBranch.test.ts): what the
 * page ends up carrying, which nodes take typing, and whether keys landed.
 */
import { describe, expect, it } from "vitest";
import {
  FIELD_JS,
  KEYS_DROPPED_JS,
  MASK_JS,
  NOTHING_LANDED_JS,
  TYPEABLE_JS,
  UNMASK_JS,
  VALUE_SNAPSHOT_JS,
} from "../src/pageScripts.js";

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const asFn = <T>(src: string): T => new Function(`return (${src})`)() as T;

describe("which nodes take typing", () => {
  const typeable = asFn<(el: unknown) => string>(TYPEABLE_JS);
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
    { what: "a select", el: element("SELECT", { value: "" }), kind: "" },
    { what: "an iframe", el: element("IFRAME"), kind: "" },
    { what: "a span", el: element("SPAN"), kind: "" },
    { what: "a contenteditable div", el: element("DIV", { getAttribute: (k: string) => (k === "contenteditable" ? "true" : null) }), kind: "" },
  ])("$what: kind=$kind", ({ el, kind }) => {
    expect(typeable(el)).toBe(kind);
  });
});

describe("whether the keys landed", () => {
  const dropped = asFn<(el: { value?: string; textContent?: string }, wanted: string) => boolean>(
    KEYS_DROPPED_JS,
  );
  it.each([
    { what: "an empty field", el: { value: "" }, wanted: "hunter2", fallback: true },
    { what: "a truncated field", el: { value: "hunt" }, wanted: "hunter2", fallback: true },
    { what: "a field holding the value", el: { value: "hunter2" }, wanted: "hunter2", fallback: false },
    { what: "a card number the field spaced out", el: { value: "4111 1111" }, wanted: "41111111", fallback: false },
    { what: "a value the field upper-cased", el: { value: "HUNTER2" }, wanted: "hunter2", fallback: false },
    { what: "a contenteditable holding the value", el: { textContent: "hunter2" }, wanted: "hunter2", fallback: false },
    { what: "an empty contenteditable", el: { textContent: "" }, wanted: "hunter2", fallback: true },
  ])("$what needs the assignment: $fallback", ({ el, wanted, fallback }) => {
    expect(dropped(el, wanted)).toBe(fallback);
  });
});

describe("whether a fill that failed left anything behind", () => {
  const nothingLanded = asFn<(el: { value?: string; textContent?: string }, previous: string) => boolean>(
    NOTHING_LANDED_JS,
  );
  const snapshot = asFn<(el: { value?: string; textContent?: string }) => string>(VALUE_SNAPSHOT_JS);

  it.each([
    { what: "an input", el: { value: "1 Elm" } },
    { what: "a contenteditable", el: { textContent: "1 Elm" } },
  ])("captures what $what was holding", ({ el }) => {
    expect(snapshot(el)).toBe("1 Elm");
  });

  it.each([
    { what: "an input still holding what it held", el: { value: "1 Elm" }, before: "1 Elm", nothing: true },
    { what: "an emptied input", el: { value: "" }, before: "1 Elm", nothing: true },
    { what: "an input holding more", el: { value: "1 Elm Sec" }, before: "1 Elm", nothing: false },
    { what: "a contenteditable still holding what it held", el: { textContent: "1 Elm" }, before: "1 Elm", nothing: true },
    { what: "an emptied contenteditable", el: { textContent: "" }, before: "1 Elm", nothing: true },
    { what: "a contenteditable holding more", el: { textContent: "1 Elm Sec" }, before: "1 Elm", nothing: false },
  ])("$what: nothing landed is $nothing", ({ el, before, nothing }) => {
    expect(nothingLanded(el, before)).toBe(nothing);
  });
});

describe("the mark the page ends up carrying", () => {
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

  const mark = asFn<(el: StubEl) => string>(MASK_JS);
  const unmark = asFn<(el: StubEl) => boolean>(UNMASK_JS);

  it("puts the attribute the forms scan looks for on the element, and nothing else", () => {
    const page = stubPage();
    const el = page.el();
    expect(mark(el)).toBe("stylesheet");
    expect(el.attrs).toEqual({ "data-domo-secret": "" });
    expect(page.doc.styles.length).toBe(1);
    expect(el.style.props).toEqual({});
  });

  it("injects the stylesheet once across repeated fills", () => {
    const page = stubPage();
    expect(mark(page.el())).toBe("stylesheet");
    expect(mark(page.el())).toBe("stylesheet");
    expect(page.doc.styles.length).toBe(1);
    expect(page.doc.styles[0].textContent).toBe("[data-domo-secret]{-webkit-text-security:disc}");
  });

  it("falls back to the element's own style when a CSP blocks the stylesheet", () => {
    const page = stubPage({ stylesheets: false });
    const el = page.el();
    expect(mark(el)).toBe("inline");
    expect(el.attrs).toEqual({ "data-domo-secret": "" });
    expect(el.style.props["-webkit-text-security"]).toBe("disc");
  });

  it("takes its own tag back off when the mark did not take", () => {
    const page = stubPage({ stylesheets: false, inlineProperties: false });
    const el = page.el();
    expect(mark(el)).toBe("unmasked");
    expect(el.attrs).toEqual({});
    expect(el.style.props).toEqual({});
  });

  it("leaves the tag alone on a field that was already masked", () => {
    const page = stubPage({ stylesheets: false, inlineProperties: false });
    const el = page.el();
    el.setAttribute("data-domo-secret", "");
    expect(mark(el)).toBe("unmasked");
    expect(el.attrs).toEqual({ "data-domo-secret": "" });
  });

  it("clears the mark and the fallback when a node is reused for a visible field", () => {
    const page = stubPage({ stylesheets: false });
    const el = page.el();
    mark(el);
    unmark(el);
    expect(el.attrs).toEqual({});
    expect(el.style.props).toEqual({});
  });

  it("lets the forms scan report a cleared node normally again", () => {
    const scan = asFn<(document: unknown) => { value: string; secret: boolean; filled: boolean }[]>(
      `() => (${FIELD_JS})()`,
    );
    const page = stubPage();
    const el = page.el();
    mark(el);
    el.value = "jon@example.com";
    const runScan = new Function("document", `return (${FIELD_JS})();`) as (
      doc: unknown,
    ) => { value: string; secret: boolean; filled: boolean }[];
    const [masked] = runScan({ querySelectorAll: () => [el] });
    expect(masked.secret).toBe(true);
    expect(masked.value).toBe("");
    unmark(el);
    const [plain] = runScan({ querySelectorAll: () => [el] });
    expect(plain.secret).toBe(false);
    expect(plain.value).toBe("jon@example.com");
    void scan;
  });
});
