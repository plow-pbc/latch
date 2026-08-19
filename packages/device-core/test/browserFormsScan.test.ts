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
  const fn = new Function("document", `return (${m[1]})();`);
  return fn as (doc: unknown) => Field[];
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

  it("reports a marked field as populated without its value", () => {
    const [f] = scan(page([{ tag: "input", name: "cc-number", value: SECRETS[1], attrs: MARK }]));
    expect(f.value).toBe("");
    expect(f.secret).toBe(true);
    expect(f.filled).toBe(true);
  });

  it("keeps a marked empty field distinguishable from a marked filled one", () => {
    const [f] = scan(page([{ tag: "input", name: "cvc", value: "", attrs: MARK }]));
    expect(f.secret).toBe(true);
    expect(f.filled).toBe(false);
  });

  it("withholds a password value with no mark at all", () => {
    const [f] = scan(page([{ tag: "input", type: "password", name: "pw", value: SECRETS[0] }]));
    expect(f.value).toBe("");
    expect(f.secret).toBe(true);
    expect(f.filled).toBe(true);
  });

  it("still returns an unmarked address field so the agent can verify it", () => {
    const [f] = scan(page([{ tag: "input", name: "address1", value: "1 Elm St" }]));
    expect(f.value).toBe("1 Elm St");
    expect(f.secret).toBe(false);
    expect(f.filled).toBe(true);
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
});
