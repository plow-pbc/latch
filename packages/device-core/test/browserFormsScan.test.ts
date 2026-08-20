/**
 * The `forms` action hands the agent every field on the page. Two kinds of
 * field must never come back with their characters: one the fill path marked
 * with `data-domo-secret` because the vault masks it, and any `type="password"`
 * box regardless of who typed into it. Both must still be reported as
 * populated, so the agent can tell a filled form from a half-empty one.
 *
 * The scanner runs inside the page, so this drives the exact source string
 * `server.py` evaluates against a stub document — no Python, no browser.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const SERVER_PY = fileURLToPath(
  new URL("../../../vendor/browser-server/server.py", import.meta.url),
);

/** Values planted in the stub page. Never asserted on — only searched for. */
const SECRETS = ["hunter2", "4111111111111111", "737"];

interface Field {
  tag: string;
  type: string;
  name: string;
  value: string;
  secret: boolean;
  filled: boolean;
}

/** The `FIELD_JS` literal, lifted from the server so the test can't drift. */
function loadScanner(): (doc: unknown) => Field[] {
  const src = fs.readFileSync(SERVER_PY, "utf8");
  const m = /^FIELD_JS = """([\s\S]*?)"""$/m.exec(src);
  if (!m) throw new Error("FIELD_JS literal not found in server.py");
  // The literal reads `location.href` alongside the fields so the two cannot
  // disagree; the stub supplies one and the scan's own answer is `.fields`.
  const fn = new Function("document", "location", `return (${m[1]})().fields;`);
  return ((doc: unknown) =>
    (fn as (d: unknown, l: unknown) => Field[])(doc, { href: "https://stub.example/" })) as (
    doc: unknown,
  ) => Field[];
}

/** The whole answer, not just its fields — see the contract test below. */
function loadScanRaw(): (doc: unknown, loc: unknown) => { url: string; fields: Field[] } {
  const src = fs.readFileSync(SERVER_PY, "utf8");
  const m = /^FIELD_JS = """([\s\S]*?)"""$/m.exec(src);
  if (!m) throw new Error("FIELD_JS literal not found in server.py");
  return new Function("document", "location", `return (${m[1]})();`) as (
    doc: unknown,
    loc: unknown,
  ) => { url: string; fields: Field[] };
}

interface Stub {
  tag: string;
  type?: string;
  name?: string;
  value?: string;
  attrs?: Record<string, string>;
  options?: string[];
}

/** Just enough DOM for the scanner: no library, no rendering. */
function page(stubs: Stub[]) {
  const els = stubs.map((s) => {
    const attrs = { ...(s.attrs ?? {}) };
    if (s.type) attrs.type = s.type;
    return {
      tagName: s.tag.toUpperCase(),
      type: s.type ?? (s.tag === "input" ? "text" : s.tag),
      name: s.name ?? "",
      id: "",
      labels: [] as { textContent: string }[],
      value: s.value ?? "",
      options: (s.options ?? []).map((value) => ({ value })),
      getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
      hasAttribute: (k: string) => k in attrs,
    };
  });
  return { querySelectorAll: () => els };
}

const MARK = { "data-domo-secret": "" };

describe("forms field scan", () => {
  const scan = loadScanner();

  // One field at a time: what the scan says about it, and what it withholds.
  it.each([
    {
      what: "a marked field is populated, without its characters",
      field: { tag: "input", name: "cc-number", value: SECRETS[1], attrs: MARK },
      value: "", secret: true, filled: true,
    },
    {
      what: "a marked EMPTY field stays tellable from a marked filled one",
      field: { tag: "input", name: "cvc", value: "", attrs: MARK },
      value: "", secret: true, filled: false,
    },
    {
      what: "a password box is withheld with no mark at all",
      field: { tag: "input", type: "password", name: "pw", value: SECRETS[0] },
      value: "", secret: true, filled: true,
    },
    {
      what: "an unmarked address still comes back, so the agent can check it",
      field: { tag: "input", name: "address1", value: "1 Elm St" },
      value: "1 Elm St", secret: false, filled: true,
    },
  ])("$what", ({ field, value, secret, filled }) => {
    const [f] = scan(page([field]));
    expect(f.value).toBe(value);
    expect(f.secret).toBe(secret);
    expect(f.filled).toBe(filled);
  });

  it("leaks no secret anywhere in the output of a mixed form", () => {
    const out = scan(
      page([
        { tag: "input", name: "user", value: "jon" },
        { tag: "input", type: "password", name: "pw", value: SECRETS[0] },
        { tag: "input", name: "cc-number", value: SECRETS[1], attrs: MARK },
        { tag: "input", name: "cvc", value: SECRETS[2], attrs: MARK },
        { tag: "input", name: "address1", value: "1 Elm St" },
        { tag: "select", name: "state", value: "CA", options: ["CA", "NY"] },
      ]),
    );
    const blob = JSON.stringify(out);
    for (const s of SECRETS) expect(blob).not.toContain(s);
    expect(out.filter((f) => f.secret).map((f) => f.name)).toEqual(["pw", "cc-number", "cvc"]);
    expect(out.find((f) => f.name === "address1")?.value).toBe("1 Elm St");
  });
  it("answers with the document's own URL beside its fields", () => {
    // The origin filter decides by this URL whether these fields may cross, so
    // the two have to come from one evaluation. Read separately, a frame that
    // navigated in between would put the old document's fields behind the new
    // document's origin — and the filter would wave them through.
    const scan = loadScanRaw();
    const { url, fields } = scan(
      page([{ tag: "input", name: "cvv", value: "123" }]),
      { href: "https://pay.example/frame?tok=abc" },
    );
    expect(url).toBe("https://pay.example/frame?tok=abc");
    expect(fields.map((f) => f.name)).toEqual(["cvv"]);
  });
});
