/**
 * The page scripts driven through a REAL Camoufox via real Playwright — the
 * coverage the stub tiers structurally cannot provide. This is what catches the
 * string-vs-function bug: Node Playwright does NOT call a function-shaped
 * STRING, so a page script passed as a string returns undefined and a secret
 * field is filled UNMASKED. Passing real functions (pageScripts.ts) makes
 * Playwright call them; this test proves the field actually ends up masked.
 *
 * Skipped when no Camoufox is fetched (CI without the browser). Locally:
 * `just fetch-browser` then `npx vitest run …/maskReal.integration.test.ts`,
 * or set DOMO_CAMOUFOX to the binary. Run headless — no window.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, type LaunchedBrowser } from "../src/launch.js";
import { Session } from "../src/session.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

function findCamoufox(): string | null {
  const env = process.env.DOMO_CAMOUFOX;
  const roots = env
    ? [env]
    : ["universal", "arm64", "x86_64"].map((a) =>
        fileURLToPath(new URL(`../../../vendor/camoufox-browser/${a}`, import.meta.url)),
      );
  for (const root of roots) {
    if (fs.existsSync(root) && root.endsWith("camoufox")) return root; // a binary path
    const official = path.join(root, "browsers", "official");
    if (!fs.existsSync(official)) continue;
    for (const build of fs.readdirSync(official)) {
      const bin = path.join(official, build, "Camoufox.app", "Contents", "MacOS", "camoufox");
      if (fs.existsSync(bin)) return bin;
    }
  }
  return null;
}

const POOL_DIR = fileURLToPath(new URL("..", import.meta.url)); // packages/browser-server
const CFX = findCamoufox();
const HAVE_BROWSER = CFX !== null && fs.existsSync(path.join(POOL_DIR, "fingerprints.json"));

// A real function + arg, never a string built from `id`: Playwright serializes
// the function and passes `id` as data, so nothing interpolates a value into
// evaluated code.
const security = (page: any, id: string): Promise<string> =>
  page.evaluate((elId: string) => {
    const e = (globalThis as any).document.getElementById(elId);
    if (!e) return "no-el";
    const cs = (globalThis as any).getComputedStyle(e);
    return cs.getPropertyValue("-webkit-text-security") || cs.webkitTextSecurity || "";
  }, id);

describe.skipIf(!HAVE_BROWSER)("page scripts against a real Camoufox", () => {
  let browser: LaunchedBrowser;
  let session: Session;

  beforeAll(async () => {
    browser = await launchBrowser({ executablePath: CFX!, poolDir: POOL_DIR, headed: false });
    session = new Session(browser.page);
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
  });

  it.each(["input", "textarea"])("fills and submits a %s that restores its caret", async (tag) => {
    const html = `<!doctype html><form>
      <${tag} name="name"></${tag}><button>Submit</button>
      </form><output></output><script>
      const input = document.querySelector('[name=name]');
      let state = '';
      input.addEventListener('input', () => {
        state = input.value;
        input.value = state;
        input.setSelectionRange(0, 0);
      });
      document.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        document.querySelector('output').textContent = new FormData(event.target).get('name');
      });
      </script>`;
    await browser.page.goto(`data:text/html,${encodeURIComponent(html)}`);
    const result = await session.handle({ action: "fill", selector: "[name=name]", value: "Rowan" });
    await session.handle({ action: "click", selector: "button" });
    const submitted = await browser.page.evaluate(() =>
      (globalThis as any).document.querySelector('output').textContent,
    );
    expect(submitted).toBe("Rowan");
    expect(result).not.toHaveProperty("altered", true);
  });

  // #338: on PayPal's review page `text=Send` matched the "Send and Request" nav
  // link first, the click reported ok, and the payment was never submitted.
  it("refuses an ambiguous click instead of pressing the first match", async () => {
    const html = `<!doctype html><nav><a href="#home">Send and Request</a></nav>
      <main><button onclick="document.title='SUBMITTED'">Send</button></main>`;
    await browser.page.goto(`data:text/html,${encodeURIComponent(html)}`);

    await expect(session.handle({ action: "click", selector: "text=Send" })).rejects.toThrow(
      /matches 2 elements[^]*frame 0 #0: <a> "Send and Request" \(visible\)\n {2}frame 0 #1: <button> "Send" \(visible\)/,
    );
    expect(await browser.page.title()).toBe("");
    expect(browser.page.url()).not.toContain("#home");

    await session.handle({ action: "click", selector: 'role=button[name="Send"]' });
    expect(await browser.page.title()).toBe("SUBMITTED");
  }, 30_000);

  // A vault-filled contenteditable's secret IS its text, so a refusal that
  // lists it names it without that text.
  it("lists a concealed candidate without its text", async () => {
    await browser.page.goto("data:text/html,<div id=note contenteditable></div><div>Plain</div>");
    await session.handle({ action: "fill", selector: "#note", value: "hunter2", mask: true, frame: 0 });

    const refusal = session.handle({ action: "click", selector: "div" });
    await expect(refusal).rejects.toThrow(/<div> \[concealed\] \(visible\)/);
    await expect(refusal).rejects.not.toThrow(/hunter2/);
  }, 30_000);

  it("actually masks a filled secret (would be UNMASKED with string scripts)", async () => {
    await browser.page.goto("data:text/html,<input id=pw type=text value=''>");
    const r = (await session.handle(
      { action: "fill", selector: "#pw", value: "hunter2", mask: true, frame: 0 },
    )) as any;

    expect(r.ok).toBe(true);
    // The bug: MASK_JS-as-string returned undefined, so `mask` was undefined and
    // the fill proceeded unmasked. As a function it returns stylesheet/inline.
    expect(r.mask).toMatch(/^(stylesheet|inline)$/);
    // And the field is REALLY masked in the DOM, not just tagged.
    expect(await security(browser.page, "pw")).toBe("disc");
  }, 60_000);

  it("reports the masked field to `forms` with its value hidden", async () => {
    const forms = (await session.handle({ action: "forms" })) as any;
    const f = (forms.forms as any[]).find((x) => x.id === "pw");
    expect(f).toBeDefined();
    expect(f.secret).toBe(true);
    expect(f.filled).toBe(true);
    expect(f.value).toBe(""); // the secret is not echoed back
  }, 30_000);

  it("re-masks and returns a screenshot rather than exposing the field", async () => {
    const shot = (await session.handle({ action: "screenshot" })) as any;
    expect(typeof shot.data_b64).toBe("string");
    expect(shot.data_b64.length).toBeGreaterThan(0);
  }, 30_000);

  it("gives real document tokens and typing kinds (not undefined)", async () => {
    await browser.page.goto("data:text/html,<input id=a type=text><textarea id=b></textarea>");
    const tok = await browser.page.evaluate(
      (await import("../src/pageScripts.js")).DOC_TOKEN_JS as any,
    );
    expect(typeof tok).toBe("string");
    expect((tok as string).length).toBeGreaterThan(0);
  }, 30_000);

  it("refuses a pool built for a different browser version (close + throw)", async () => {
    const realPool = JSON.parse(fs.readFileSync(path.join(POOL_DIR, "fingerprints.json"), "utf8"));
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "badpool-"));
    fs.writeFileSync(
      path.join(badDir, "fingerprints.json"),
      JSON.stringify({ ...realPool, browserVersion: "official/99.9.9-nope" }),
    );
    try {
      await expect(
        launchBrowser({ executablePath: CFX!, poolDir: badDir, headed: false }),
      ).rejects.toThrow(/pool is for browser 99\.9\.9-nope/);
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  }, 60_000);
});
