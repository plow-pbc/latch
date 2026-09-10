/**
 * The page-side code the browser server evaluates INSIDE the page — extractors
 * and the secret-masking machinery.
 *
 * These are REAL FUNCTIONS, not source strings. Node's Playwright treats a
 * string passed to `evaluate` as an *expression* and does NOT call it (a
 * function-shaped string evaluates to the function object and returns
 * undefined) — unlike Python's Playwright, which the retired `server.py` relied
 * on. Passing functions makes Playwright serialize and CALL them with
 * `(element, arg)`; a real-browser test (`maskReal.integration.test.ts`) proves
 * the field is actually masked, which the stub suite structurally cannot.
 *
 * Each function must be SELF-CONTAINED: Playwright serializes it by `toString()`
 * and runs it in the browser, so it may not close over any module-scope value.
 * The `held` logic is therefore inlined into each function rather than shared.
 * `document`/`window` are the browser's globals (declared here only so this
 * Node package typechecks without the DOM lib; the declarations emit no code).
 *
 * A credential value never appears here; these operate on nodes, never on stored
 * secrets.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const document: any;
declare const window: any;

type El = any;

export const FIELD_JS = (): any[] =>
  Array.from(document.querySelectorAll("input,select,textarea"))
    .slice(0, 40)
    .map((el: El) => {
      let lab = "";
      if (el.labels && el.labels[0]) lab = el.labels[0].textContent.trim();
      if (!lab) lab = el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
      // A field the fill path masked, and any password box whoever filled it,
      // reports only that it holds something. `filled` keeps such a field
      // distinguishable from an empty one, so a form can be checked for
      // completeness.
      const secret = el.hasAttribute("data-domo-secret") || el.type === "password";
      const val = el.value || "";
      return {
        tag: el.tagName.toLowerCase(),
        type: el.type || "",
        name: el.name || "",
        id: el.id || "",
        label: lab,
        placeholder: el.getAttribute("placeholder") || "",
        maxlength: el.getAttribute("maxlength") || "",
        options:
          el.tagName === "SELECT"
            ? Array.from(el.options)
                .map((o: any) => o.value)
                .filter(Boolean)
                .slice(0, 40)
            : [],
        secret,
        filled: val.length > 0,
        value: secret ? "" : val.substring(0, 50),
      };
    });

export const LINKS_JS = (): any[] => {
  const seen = new Set<string>();
  return Array.from(document.querySelectorAll("a[href]"))
    .filter((a: El) => {
      const t = a.textContent.trim();
      if (!t || t.length > 80 || seen.has(t)) return false;
      seen.add(t);
      return true;
    })
    .slice(0, 50)
    .map((a: El) => ({ text: a.textContent.trim(), href: a.href }));
};

export const TABLES_JS = (): any[] =>
  Array.from(document.querySelectorAll("table")).map((t: El) => ({
    headers: Array.from(t.querySelectorAll("th")).map((th: El) => th.textContent.trim()),
    rows: Array.from(t.querySelectorAll("tr"))
      .slice(1)
      .slice(0, 20)
      .map((tr: El) => Array.from(tr.querySelectorAll("td")).map((td: El) => td.textContent.trim())),
  }));

/**
 * Marking a secret the vault masks, at the moment it is filled: one attribute on
 * the element, and one stylesheet rule per document that renders anything
 * carrying it as discs. An attribute is used rather than an inline style because
 * React manages the style prop and clobbers it on re-render, while it leaves
 * attributes it has never heard of alone. The rule is injected at most once.
 * Returns "stylesheet" | "inline" | "unmasked".
 */
export const MASK_JS = (el: El): string => {
  // Whether this node was ALREADY masked decides what to undo if the mark does
  // not take: a field carrying a secret keeps its tag, one that was not must be
  // handed back exactly as found.
  const wasMarked = el.hasAttribute("data-domo-secret");
  el.setAttribute("data-domo-secret", "");
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const masked = (): boolean => {
    if (!win || !win.getComputedStyle) return false;
    const cs = win.getComputedStyle(el);
    if (!cs) return false;
    return (cs.getPropertyValue("-webkit-text-security") || cs.webkitTextSecurity) === "disc";
  };
  if (!doc.getElementById("domo-secret-style")) {
    const style = doc.createElement("style");
    style.id = "domo-secret-style";
    style.textContent = "[data-domo-secret]{-webkit-text-security:disc}";
    (doc.head || doc.documentElement).appendChild(style);
  }
  // The stylesheet is not enough on its own: a page whose CSP omits
  // 'unsafe-inline' from style-src blocks a <style> element outright. So the
  // question is not "did we inject it" but "is this node actually masked".
  if (masked()) return "stylesheet";
  // Setting a property directly on the element's style object is the one route
  // CSP does not police.
  el.style.setProperty("-webkit-text-security", "disc");
  el.style.webkitTextSecurity = "disc";
  if (masked()) return "inline";
  if (!wasMarked) {
    el.removeAttribute("data-domo-secret");
    el.style.removeProperty("-webkit-text-security");
  }
  return "unmasked";
};

/**
 * Which document this is. A token is stamped on `window` the first time it is
 * asked for and read back afterwards: a new document gets a fresh `window` and a
 * fresh token, while a same-document navigation keeps both. Non-enumerable.
 *
 * A change to this token reads as a new document, and a new document is what
 * empties the concealed-field ledger the `eval` gate is decided from. So a
 * token is only identity if it CANNOT change AND COMPARES EQUAL TO ITSELF:
 * what is already there is trusted only when it is a non-configurable,
 * non-writable, non-empty string — which is the only kind this ever writes.
 * Anything else is not identity and gets restamped, whoever left it there:
 * absent, deletable, assignable, an accessor free to answer differently each
 * time, or a value that is unequal to itself. `NaN` is immutable and still
 * reads as a different document on every look, which empties the ledger
 * before every action — so "cannot be changed" was never the whole test.
 *
 * That is the whole check, and deliberately not "we got here first": an
 * expression the agent ran earlier can open a same-origin popup and plant a
 * mutable token in it before this ever looks, so being first was never
 * something to rely on. Immutability is checkable at the moment of use;
 * arrival order is not.
 */
export const DOC_TOKEN_JS = (): string => {
  const w = window;
  const held = Object.getOwnPropertyDescriptor(w, "__domoDocumentToken");
  if (
    held === undefined ||
    held.configurable ||
    held.writable !== false ||
    typeof held.value !== "string" ||
    held.value === "" ||
    // The ledger keys are `token:selector`, split at the first colon. A token
    // carrying one would make the selector unparseable — and a selector is
    // what the refusal hands the agent to go and clear. Nothing this mints
    // contains one.
    held.value.indexOf(":") !== -1
  ) {
    try {
      // Every attribute spelled out: redefining a property that already exists
      // KEEPS whatever it was given for the ones left unsaid, so a restamp that
      // only names `value` inherits the planted property's mutability and hands
      // the forgery straight back.
      Object.defineProperty(w, "__domoDocumentToken", {
        value: Math.random().toString(36).slice(2) + Date.now().toString(36),
        configurable: false,
        writable: false,
        enumerable: false,
      });
    } catch {
      // A non-configurable accessor cannot be replaced by anything, ever — the
      // one shape that can hold this name against us. So this document has no
      // identity we are willing to state, and says so: "" is not a token, and
      // the server treats it as one it must not reason from.
      return "";
    }
  }
  return w.__domoDocumentToken;
};

/**
 * What KIND of typing this node takes, or "" for none. Only a <textarea> and a
 * text-carrying <input> are typed at; a single <select> has an option chosen;
 * everything else is assigned. The two typed kinds differ on whether the node
 * holds a line break (textarea) or strips it (input).
 */
export const TYPEABLE_JS = (el: El): string => {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return el.disabled || el.readOnly ? "" : "multiline";
  if (tag === "select") return el.disabled || el.multiple ? "" : "select";
  if (tag !== "input") return "";
  const typed = ["text", "email", "password", "search", "tel", "url", "number"];
  if (!typed.includes(el.type)) return "";
  return el.disabled || el.readOnly ? "" : "single-line";
};

/** Repair a restored caret without selecting on fields that advance normally. */
export const MOVE_CARET_IF_REGRESSED_JS = (node: El, expected: number): number | null => {
  if ((node.tagName === "INPUT" || node.tagName === "TEXTAREA") && node.selectionStart !== null) {
    if (node.selectionStart < expected) node.setSelectionRange(node.value.length, node.value.length);
    return node.selectionStart;
  }
  return null;
};

// How a node holds its text: `value` for input/textarea, `textContent` else.
// Inlined into each function below (a shared const would not survive
// serialization into the page).

/** What a node is holding, captured before a fill so a failure has something
 * exact to compare against. Returned as a handle that stays in the page. */
export const VALUE_SNAPSHOT_JS = (el: El): string =>
  typeof el.value === "string" ? el.value : el.textContent || "";

/** Whether the keys failed to land, in the only two shapes an assignment could
 * repair: the field took none of them, or a prefix and stopped. */
export const KEYS_DROPPED_JS = (el: El, wanted: string): boolean => {
  const now = typeof el.value === "string" ? el.value : el.textContent || "";
  return now !== wanted && wanted.startsWith(now);
};

/** Whether a fill that failed left anything behind: unchanged or empty. */
export const NOTHING_LANDED_JS = (el: El, previous: string): boolean => {
  const now = typeof el.value === "string" ? el.value : el.textContent || "";
  return now === "" || now === previous;
};

/** Whether a node is already carrying the mark, asked before anything touches it. */
export const WAS_MARKED_JS = (el: El): boolean => el.hasAttribute("data-domo-secret");

/** How much this field will hold, and -1 when it does not say. */
export const FIELD_CAP_JS = (el: El): number => {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return el.maxLength;
  if (tag !== "input") return -1;
  return ["text", "search", "url", "tel", "email", "password"].includes(el.type)
    ? el.maxLength
    : -1;
};

/**
 * Whether the field is holding what was typed into it. Compared IN THE PAGE. A
 * select was asked for an option by value OR label, so either counts.
 *
 * Not string equality: a page is allowed to pretty-print. A 2FA box hyphenates
 * six digits, a card field groups four, a date field slashes. The field still
 * received the credential, and refusing those was refusing the login. What it
 * may not do is lose a character, gain one that is not formatting, or reorder
 * what it has — any of those and the value the page will submit is not the
 * value the vault released.
 *
 * This is a correctness check, not a concealment one: a page that wants the
 * value has it the moment it is typed, whatever it leaves in `el.value`.
 * Concealment is the mark and the `forms` redaction, and neither moves here.
 */
export const HELD_MATCHES_JS = (el: El, wanted: string): boolean => {
  if (el.tagName === "SELECT") {
    const chosen = el.selectedOptions && el.selectedOptions[0];
    return el.value === wanted || (!!chosen && (chosen.label || "").trim() === wanted);
  }
  const held = typeof el.value === "string" ? el.value : el.textContent || "";
  if (held === wanted) return true;
  // A clear is exact: a field still holding the separator a rollback left is
  // not empty, and must never be reported as empty.
  if (wanted === "") return false;
  // Both sides walk by code point: `for...of` hands `held` an astral character
  // whole, and indexing `wanted` by code unit would compare it against a lone
  // surrogate that can never match.
  const want = Array.from(wanted);
  let i = 0;
  for (const ch of held) {
    if (i < want.length && ch === want[i]) {
      i++;
    } else if (!/[\s\-/.()+]/.test(ch)) {
      return false;
    }
  }
  return i === want.length;
};

export const UNMASK_JS = (el: El): boolean => {
  el.removeAttribute("data-domo-secret");
  if (el.style) {
    el.style.removeProperty("-webkit-text-security");
  }
  return true;
};

/** Scroll one viewport (or to an edge) — the map `scroll` selects from. These
 * are plain EXPRESSIONS (not functions), which Playwright evaluates directly. */
export const SCROLL_JS: Record<string, string> = {
  down: "window.scrollBy(0,window.innerHeight)",
  up: "window.scrollBy(0,-window.innerHeight)",
  bottom: "window.scrollTo(0,document.body.scrollHeight)",
  top: "window.scrollTo(0,0)",
};
