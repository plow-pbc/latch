/**
 * The JavaScript the browser server evaluates INSIDE the page — extractors and
 * the secret-masking machinery. These are the exact strings the old
 * vendor/browser-server/server.py held as `"""…"""` literals; keeping them here
 * as named exports lets the unit tests assert against the very source the server
 * runs (no Python, no browser), the way `loadScript` used to lift them.
 *
 * A credential value never appears here; these operate on nodes, never on stored
 * secrets.
 */

export const FIELD_JS = `() => Array.from(document.querySelectorAll("input,select,textarea")).slice(0,40).map(el => {
    let lab = "";
    if (el.labels && el.labels[0]) lab = el.labels[0].textContent.trim();
    if (!lab) lab = el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
    // A field the vault masks, and any password box whoever filled it, reports
    // only that it holds something. \`filled\` keeps such a field distinguishable
    // from an empty one, so a form can still be checked for completeness.
    const secret = el.hasAttribute("data-domo-secret") || el.type === "password";
    const val = el.value || "";
    return {
      tag: el.tagName.toLowerCase(), type: el.type || "", name: el.name || "",
      id: el.id || "", label: lab,
      placeholder: el.getAttribute("placeholder") || "",
      maxlength: el.getAttribute("maxlength") || "",
      options: el.tagName === "SELECT"
        ? Array.from(el.options).map(o => o.value).filter(Boolean).slice(0, 40) : [],
      secret: secret, filled: val.length > 0,
      value: secret ? "" : val.substring(0, 50)
    };
  })`;

export const LINKS_JS = `() => {
    const seen = new Set();
    return Array.from(document.querySelectorAll("a[href]"))
        .filter(a => { const t = a.textContent.trim(); if (!t || t.length > 80 || seen.has(t)) return false; seen.add(t); return true; })
        .slice(0, 50).map(a => ({text: a.textContent.trim(), href: a.href}));
}`;

export const TABLES_JS = `() => Array.from(document.querySelectorAll("table")).map(t => ({
    headers: Array.from(t.querySelectorAll("th")).map(th => th.textContent.trim()),
    rows: Array.from(t.querySelectorAll("tr")).slice(1).slice(0,20).map(tr =>
        Array.from(tr.querySelectorAll("td")).map(td => td.textContent.trim()))
}))`;

/**
 * Marking a secret the vault masks, at the moment it is filled: one attribute on
 * the element, and one stylesheet rule per document that renders anything
 * carrying it as discs. An attribute is used rather than an inline style because
 * React manages the style prop and clobbers it on re-render, while it leaves
 * attributes it has never heard of alone. The rule is injected at most once — a
 * document that already carries it is left as it is.
 */
export const MASK_JS = `(el) => {
    // Whether this node was ALREADY masked decides what to undo if the mark
    // does not take: a field that was carrying a secret keeps its tag, while
    // one that was not must be handed back exactly as it was found. Leaving the
    // tag on an ordinary field withholds its value from \`forms\` for good.
    const wasMarked = el.hasAttribute("data-domo-secret");
    el.setAttribute("data-domo-secret", "");
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    const masked = () => {
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
    // 'unsafe-inline' from style-src blocks a <style> element outright, and the
    // mark would then be an attribute that changes nothing while the value
    // renders in the clear. So the question is not "did we inject it" but "is
    // this node actually masked", which is what the computed style answers.
    if (masked()) return "stylesheet";
    // Setting a property directly on the element's style object is the one
    // route CSP does not police -- unlike a style attribute or cssText, which
    // style-src blocks exactly as it blocks a <style> element.
    el.style.setProperty("-webkit-text-security", "disc");
    el.style.webkitTextSecurity = "disc";
    if (masked()) return "inline";
    if (!wasMarked) {
        el.removeAttribute("data-domo-secret");
        el.style.removeProperty("-webkit-text-security");
    }
    return "unmasked";
}`;

/**
 * Which document this is. A token is stamped on `window` the first time it is
 * asked for and read back afterwards: a new document gets a fresh `window` and
 * therefore a fresh token, while a same-document navigation — pushState, a hash
 * change, history.back within an SPA — keeps both. Non-enumerable, so it does
 * not show up in anything the page or the agent enumerates.
 */
export const DOC_TOKEN_JS = `() => {
    const w = window;
    if (!w.__domoDocumentToken) {
        Object.defineProperty(w, "__domoDocumentToken", {
            value: Math.random().toString(36).slice(2) + Date.now().toString(36),
            configurable: true,
        });
    }
    return w.__domoDocumentToken;
}`;

/**
 * What KIND of typing this node takes, or "" for none. `type()` refuses nothing,
 * so every node `fill()` treats specially has to be recognised here instead.
 * Only a <textarea> and a text-carrying <input> are typed at; everything else is
 * assigned. The two differ on whether the node holds a line break as a
 * character (textarea) or strips it (input value sanitization).
 */
export const TYPEABLE_JS = `(el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return el.disabled || el.readOnly ? "" : "multiline";
    if (tag !== "input") return "";
    const typed = ["text", "email", "password", "search", "tel", "url", "number"];
    if (!typed.includes(el.type)) return "";
    return el.disabled || el.readOnly ? "" : "single-line";
}`;

/**
 * How a node holds its text: `value` for an input or a textarea, `textContent`
 * for anything else. Every node reaches the ASSIGNMENT path, so the snapshot and
 * nothing-landed questions are asked of a contenteditable too — asking an input
 * for its textContent, or a contenteditable for its value, reads it as empty.
 */
const HELD = "(typeof el.value === 'string' ? el.value : (el.textContent || ''))";

/**
 * What a node is holding, captured before a fill so a failure has something
 * exact to be compared against. It stays in the page as a handle and is compared
 * there, so it never crosses the wire.
 */
export const VALUE_SNAPSHOT_JS = `(el) => ${HELD}`;

/**
 * Whether the keys failed to land, in the only two shapes an assignment could
 * repair: the field took none of them, or it took a prefix and stopped. A field
 * that REFORMATS what it was given took every key and holds something else on
 * purpose, so it is not a prefix and is left alone.
 */
export const KEYS_DROPPED_JS = `(el, wanted) => {
    const now = ${HELD};
    return now !== wanted && wanted.startsWith(now);
}`;

/**
 * Whether a fill that failed left anything behind. Unchanged is one way to hold
 * nothing unaccounted for; empty is the other — a fill assigns before it types,
 * so a failure at the first key leaves the node holding nothing.
 */
export const NOTHING_LANDED_JS = `(el, previous) => {
    const now = ${HELD};
    return now === '' || now === previous;
}`;

/** Whether a node is already carrying the mark, asked before anything touches it. */
export const WAS_MARKED_JS = `(el) => el.hasAttribute("data-domo-secret")`;

/**
 * How much this field will hold, and -1 when it does not say. `maxLength`
 * reflects the attribute even on kinds the browser never enforces it for, so
 * reading one there would turn a stray authoring mistake into a refused fill.
 */
export const FIELD_CAP_JS = `(el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return el.maxLength;
    if (tag !== "input") return -1;
    return ["text", "search", "url", "tel", "email", "password"].includes(el.type)
        ? el.maxLength
        : -1;
}`;

/**
 * Is the field holding exactly what was put into it? Compared IN THE PAGE, the
 * way the prefix test is: the value goes in, a boolean comes back. Exactly, with
 * no allowance for what the field might have been entitled to change.
 */
export const HELD_MATCHES_JS = `(el, wanted) => ${HELD} === wanted`;

export const UNMASK_JS = `(el) => {
    el.removeAttribute("data-domo-secret");
    if (el.style) {
        el.style.removeProperty("-webkit-text-security");
    }
    return true;
}`;

/** Scroll one viewport (or to an edge) — the map `scroll` selects from. */
export const SCROLL_JS: Record<string, string> = {
  down: "window.scrollBy(0,window.innerHeight)",
  up: "window.scrollBy(0,-window.innerHeight)",
  bottom: "window.scrollTo(0,document.body.scrollHeight)",
  top: "window.scrollTo(0,0)",
};
