/**
 * The browser server's inline JavaScript, lifted from `server.py` so a test
 * cannot drift from what actually runs in the page.
 *
 * One loader for every caller: the literals are read and parsed here rather
 * than in each test file, and `DOC_WHERE_JS`'s composition of `DOC_TOKEN_JS`
 * is resolved here too — restating that in a test is how the test comes to
 * agree with itself instead of with the server.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const SERVER_PY = fileURLToPath(
  new URL("../../../vendor/browser-server/server.py", import.meta.url),
);

/** The body of a `NAME = """…"""` literal, with any `% OTHER` composed in. */
export function scriptSource(name: string): string {
  const src = fs.readFileSync(SERVER_PY, "utf8");
  const m = new RegExp(`^${name} = """([\\s\\S]*?)"""( % (\\w+))?$`, "m").exec(src);
  if (!m) throw new Error(`${name} literal not found in server.py`);
  // A replacer function, not a replacement string: `$&` and friends are
  // special in the latter, and the script being spliced in is arbitrary text.
  return m[3] === undefined ? m[1] : m[1].replace("%s", () => scriptSource(m[3]));
}

/** The literal as the arrow it is — call it the way the server calls it. */
export function loadScript<T>(name: string): T {
  return new Function(`return (${scriptSource(name)})`)() as T;
}

/**
 * The literal invoked in a scope the page would have given it. `FIELD_JS` and
 * `DOC_WHERE_JS` take no arguments and read `document`, `location` or `window`
 * from around them, so the stub for those goes in as scope rather than args.
 */
export function runInScope<T>(name: string, ...params: string[]): (...values: unknown[]) => T {
  const fn = new Function(...params, `return (${scriptSource(name)})()`);
  return (...values: unknown[]) => fn(...values) as T;
}
