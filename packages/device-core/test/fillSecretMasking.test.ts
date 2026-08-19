/**
 * `fill_secret` marks the element it fills when — and only when — the vault
 * masks that field, so the value the agent just typed cannot be read back off
 * the page as pixels.
 *
 * Two layers, because the mark spans the seam: what the device asks the browser
 * to do (the `mask` flag on the fill action, decided from Chunk 1's `hidden`),
 * and what the page ends up carrying (the `MASK_JS` source string `server.py`
 * evaluates, run here against a stub document — no Python, no browser).
 *
 * No secret value is asserted on anywhere below.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSONValue, jv } from "@domo/protocol";
import { BrowserHost, BrowserSessions, CredentialBroker, masksField } from "@domo/device-core";

const FAKE_SERVER = fileURLToPath(
  new URL("../../../e2e/fixtures/fakeBrowserServer.cjs", import.meta.url),
);
const FAKE_BROKER = fileURLToPath(
  new URL("../../../e2e/fixtures/fakeVaultBroker.cjs", import.meta.url),
);
const SERVER_PY = fileURLToPath(
  new URL("../../../vendor/browser-server/server.py", import.meta.url),
);
const FILL_PROBE = fileURLToPath(new URL("../../../e2e/fixtures/fillProbe.py", import.meta.url));

/** The probe needs a python3; the rest of this file never does. */
const HAVE_PYTHON = (() => {
  try {
    execFileSync("python3", ["-c", "pass"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

interface Ctx {
  sessions: BrowserSessions;
  host: BrowserHost;
  events: { event: string; fields: { [k: string]: JSONValue } }[];
  dir: string;
  cmdLog: string;
  brokerLog: string;
}

let ctx: Ctx;

function makeCtx(serverEnv: Record<string, string> = {}): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-mask-"));
  const cmdLog = path.join(dir, "cmds.log");
  const brokerLog = path.join(dir, "broker-audit.log");
  const vaultPath = path.join(dir, "vault.json");
  fs.writeFileSync(
    vaultPath,
    JSON.stringify([
      {
        id: "L1",
        title: "Pizza Login",
        category: "LOGIN",
        username: "jon",
        urls: ["https://pizza.example/login"],
        fields: {
          username: "jon",
          password: "hunter2",
          "shipping address": { value: "1 Elm St", custom: true, type: 0 },
        },
      },
      {
        id: "C1",
        title: "Visa",
        category: "CREDIT_CARD",
        username: "",
        urls: [],
        fields: {
          number: "4111111111111111",
          code: "737",
          "cardholder name": "Jon Doe",
        },
      },
      {
        id: "I1",
        title: "Home",
        category: "IDENTITY",
        username: "",
        urls: [],
        fields: {
          ssn: "078-05-1120",
          "passport number": "X1234567",
          "license number": "D9999",
          address1: "1 Elm St",
          city: "Springfield",
        },
      },
    ]),
  );
  const events: Ctx["events"] = [];
  const host = new BrowserHost({
    command: [process.execPath, FAKE_SERVER],
    headed: false,
    screenshotsDir: path.join(dir, "shots"),
    env: { FAKE_CMD_LOG: cmdLog, ...serverEnv },
    audit: () => {},
  });
  const credentials = new CredentialBroker({
    command: [process.execPath, FAKE_BROKER],
    env: { FAKE_BROKER_VAULT: vaultPath },
    auditPath: brokerLog,
  });
  const sessions = new BrowserSessions(
    host,
    credentials,
    (event, fields) => events.push({ event, fields }),
  );
  return { sessions, host, events, dir, cmdLog, brokerLog };
}

/** Open a session already approved for both items and both origins. */
async function session(): Promise<string> {
  const opened = await ctx.sessions.open("i1", "agent-1", ["pizza.example", "payframe.example"], false);
  const handle = (opened as { session: string }).session;
  ctx.sessions.extend("i2", "agent-1", handle, [], ["L1", "C1", "I1"], false);
  await ctx.sessions.command("agent-1", handle, {
    action: "goto",
    url: "https://pizza.example/login",
  });
  return handle;
}

/**
 * The fill commands the device sent, projected to what this test is about. The
 * raw log carries the value being typed, so nothing here ever returns it — not
 * into an assertion, and not into a failure diff.
 */
function fills(): { selector: string; mask?: boolean }[] {
  return fs
    .readFileSync(ctx.cmdLog, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { action: string; selector: string; mask?: boolean })
    .filter((c) => c.action === "fill")
    .map((c) => ("mask" in c ? { selector: c.selector, mask: c.mask } : { selector: c.selector }));
}

beforeEach(() => {
  ctx = makeCtx();
});

afterEach(async () => {
  await ctx.host.shutdown();
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

describe("fill_secret marking", () => {
  it("asks the browser to mark a field the vault masks", async () => {
    const handle = await session();
    const result = await ctx.sessions.command("agent-1", handle, {
      action: "fill_secret",
      selector: "#pass",
      item: "L1",
      field: "password",
    });
    expect(result).toEqual({ status: "completed", ok: true, frame: 0 });
    expect(fills()).toEqual([{ selector: "#pass", mask: true }]);
  });

  it("adds nothing to the page for a field the vault does not mask", async () => {
    const handle = await session();
    await ctx.sessions.command("agent-1", handle, {
      action: "fill_secret",
      selector: "#addr",
      item: "L1",
      field: "shipping address",
    });
    const [fill] = fills();
    expect(fill.selector).toBe("#addr");
    expect("mask" in fill).toBe(false);
  });

  it("marks a card number and its security code, but not the cardholder name", async () => {
    const handle = await session();
    for (const [selector, field] of [
      ["#card-number", "number"],
      ["#card-cvc", "code"],
      ["#card-name", "cardholder name"],
    ]) {
      await ctx.sessions.command("agent-1", handle, {
        action: "fill_secret",
        selector,
        item: "C1",
        field,
      });
    }
    expect(fills().map((f) => f.mask === true)).toEqual([true, true, false]);
  });

  it("refuses a field the vault does not describe instead of masking it", async () => {
    const handle = await session();
    const result = await ctx.sessions.command("agent-1", handle, {
      action: "fill_secret",
      selector: "#pass",
      item: "L1",
      field: "who-knows",
    });
    expect(jv(result).get("status").str).toBe("error");
    expect(jv(result).get("error").str).toContain("has no field called who-knows");
    // Refused before anything was fetched or typed: no fill reached the browser.
    expect(fills()).toEqual([]);
    expect(ctx.events.at(-1)).toEqual({
      event: "credential_denied",
      fields: {
        session: handle,
        item: "L1",
        field: "who-knows",
        origin: "pizza.example",
        reason: "no such field on the item",
      },
    });
  });

  it("refuses the fill when the vault cannot be asked at all", async () => {
    const handle = await session();
    // A broker that answers get-field but cannot describe: the classification is
    // unavailable, so the value must not be typed either way.
    const broken = path.join(ctx.dir, "broken-broker.cjs");
    fs.writeFileSync(
      broken,
      'if (process.argv[2] === "describe-item") {\n' +
        '  process.stderr.write(JSON.stringify({ type: "VaultLocked", message: "BROKER-TEXT-VERBATIM" }) + "\\n");\n' +
        "  process.exit(1);\n}\nprocess.stdout.write('x');\n",
    );
    const sessions = new BrowserSessions(
      ctx.host,
      new CredentialBroker({ command: [process.execPath, broken] }),
      (event, fields) => ctx.events.push({ event, fields }),
    );
    const opened = await sessions.open("i1", "agent-1", ["pizza.example"], false);
    const h = (opened as { session: string }).session;
    sessions.extend("i2", "agent-1", h, [], ["L1"], false);
    await sessions.command("agent-1", h, { action: "goto", url: "https://pizza.example/login" });
    const before = fills().length;
    const result = await sessions.command("agent-1", h, {
      action: "fill_secret",
      selector: "#pass",
      item: "L1",
      field: "password",
    });
    expect(jv(result).get("status").str).toBe("error");
    expect(jv(result).get("error").str).toContain("could not check with the vault");
    // Locally authored: nothing the broker said is forwarded.
    expect(JSON.stringify(result)).not.toContain("BROKER-TEXT-VERBATIM");
    expect(JSON.stringify(ctx.events.at(-1))).not.toContain("BROKER-TEXT-VERBATIM");
    expect(fills().length).toBe(before);
    expect(ctx.events.at(-1)?.event).toBe("credential_denied");
    expect(ctx.events.at(-1)?.fields.reason).toBe("the vault could not be asked which fields it masks");
  });

  it("asks the vault about an item once per session, not once per fill", async () => {
    const handle = await session();
    for (const selector of ["#pass", "#pass2", "#pass3"]) {
      await ctx.sessions.command("agent-1", handle, {
        action: "fill_secret",
        selector,
        item: "L1",
        field: "password",
      });
    }
    const described = () =>
      fs.readFileSync(ctx.brokerLog, "utf8").trim().split("\n").filter((l) => l.includes("DESCRIBED"));
    expect(fills().length).toBe(3);
    expect(described().length).toBe(1);

    // Widening the session drops what was cached: the vault is asked again.
    ctx.sessions.extend("i3", "agent-1", handle, [], ["C1"], false);
    await ctx.sessions.command("agent-1", handle, {
      action: "fill_secret",
      selector: "#pass",
      item: "L1",
      field: "password",
    });
    expect(described().length).toBe(2);
  });

  it("fills an identity item, masking what the client conceals and nothing else", async () => {
    const handle = await session();
    const wanted: [string, string][] = [
      ["#ssn", "ssn"],
      ["#passport", "passport number"],
      ["#licence", "license number"],
      ["#addr1", "address1"],
      ["#city", "city"],
    ];
    for (const [selector, field] of wanted) {
      const result = await ctx.sessions.command("agent-1", handle, {
        action: "fill_secret",
        selector,
        item: "I1",
        field,
      });
      // Every one of them releases: an identity is not a listable-but-unusable
      // item any more.
      expect(jv(result).get("ok").bool, `${field} should have filled`).toBe(true);
    }
    expect(fills()).toEqual([
      { selector: "#ssn", mask: true },
      { selector: "#passport", mask: true },
      { selector: "#licence" },
      { selector: "#addr1" },
      { selector: "#city" },
    ]);
  });

  it("refuses to fill when the page will not let the value be masked", async () => {
    // A page whose CSP blocks the mask: the attribute would go on and change
    // nothing, and the secret would be legible in every screenshot after it.
    await ctx.host.shutdown();
    ctx = makeCtx({ FAKE_CSP_BLOCKS_MASK: "1" });
    const handle = await session();
    const before = ctx.events.length;
    const result = await ctx.sessions.command("agent-1", handle, {
      action: "fill_secret",
      selector: "#pass",
      item: "L1",
      field: "password",
    });
    expect(jv(result).get("status").str).toBe("error");
    expect(jv(result).get("error").str).toContain("stops the value from being hidden on screen");
    expect(ctx.events.slice(before)).toEqual([
      {
        event: "credential_denied",
        fields: {
          session: handle,
          item: "L1",
          field: "password",
          origin: "pizza.example",
          selector: "#pass",
          reason: "the page prevented the value from being masked",
        },
      },
    ]);
    // Nothing about the refusal, and nothing of the value, reaches the agent or
    // the audit stream.
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(ctx.events)).not.toContain("hunter2");
  });

  it("still fills a field the vault does not conceal on such a page", async () => {
    // The refusal is about masking, so a field that was never going to be
    // masked is unaffected.
    await ctx.host.shutdown();
    ctx = makeCtx({ FAKE_CSP_BLOCKS_MASK: "1" });
    const handle = await session();
    const result = await ctx.sessions.command("agent-1", handle, {
      action: "fill_secret",
      selector: "#addr",
      item: "L1",
      field: "shipping address",
    });
    expect(jv(result).get("ok").bool).toBe(true);
  });

  it("keeps the filled value out of the fixture's own command log", async () => {
    const handle = await session();
    await ctx.sessions.command("agent-1", handle, {
      action: "fill_secret",
      selector: "#pass",
      item: "L1",
      field: "password",
    });
    // The log is written by the fake browser server. A credential value may not
    // reach a log line, and a fixture's log is still a log line.
    const raw = fs.readFileSync(ctx.cmdLog, "utf8");
    expect(raw).toContain('"action":"fill"');
    expect(raw).not.toContain("hunter2");
  });

  it("leaves the result and the audit record exactly as they were", async () => {
    const handle = await session();
    const before = ctx.events.length;
    const masked = await ctx.sessions.command("agent-1", handle, {
      action: "fill_secret",
      selector: "#pass",
      item: "L1",
      field: "password",
    });
    const plain = await ctx.sessions.command("agent-1", handle, {
      action: "fill_secret",
      selector: "#addr",
      item: "L1",
      field: "shipping address",
    });
    // Byte-identical results, mark or no mark: nothing about the mask reaches
    // the agent.
    expect(JSON.stringify(masked)).toBe('{"status":"completed","ok":true,"frame":0}');
    expect(JSON.stringify(plain)).toBe('{"status":"completed","ok":true,"frame":0}');
    expect(ctx.events.slice(before)).toEqual([
      {
        event: "credential_filled",
        fields: { session: handle, item: "L1", field: "password", origin: "pizza.example" },
      },
      {
        event: "credential_filled",
        fields: { session: handle, item: "L1", field: "shipping address", origin: "pizza.example" },
      },
    ]);
    for (const e of ctx.events) expect(JSON.stringify(e)).not.toContain("hunter2");
  });
});

describe("the mask decision", () => {
  // Exactly what the broker reports for a card: the slot, its aliases carrying
  // the slot's flag, and a custom field shadowing a built-in's name.
  const FIELDS = [
    { label: "code", hidden: true, custom: false, alias: false },
    { label: "cvv", hidden: true, custom: false, alias: true },
    { label: "security code", hidden: true, custom: false, alias: true },
    { label: "cardholder name", hidden: false, custom: false, alias: false },
    { label: "cardholder name", hidden: true, custom: true, alias: false },
  ];

  it("follows the vault's own flag", () => {
    expect(masksField(FIELDS, "code")).toBe(true);
    expect(masksField([{ label: "username", hidden: false, custom: false }], "username")).toBe(false);
  });

  it("takes the aliases from the broker rather than keeping a table of its own", () => {
    expect(masksField(FIELDS, "cvv")).toBe(true);
    expect(masksField(FIELDS, "security code")).toBe(true);
  });

  it("lets the built-in decide a name collision, not the order of the list", () => {
    // `get-field cardholder name` releases the card's own slot, which the vault
    // does not mask — whichever of the two descriptors happens to come first.
    expect(masksField(FIELDS, "cardholder name")).toBe(false);
    expect(masksField([...FIELDS].reverse(), "cardholder name")).toBe(false);
  });

  it("refuses to answer for a name the vault did not describe", () => {
    expect(masksField(FIELDS, "who-knows")).toBeNull();
    expect(masksField([], "password")).toBeNull();
  });
});

/**
 * Mark and fill must land on the SAME resolved node. Resolving the selector
 * twice is the re-resolution failure §3.2 exists to avoid: a re-render between
 * the two leaves the attribute on a detached node and the value in a fresh,
 * unmarked one.
 *
 * Only the real Python can answer that, so it is driven directly — skipped, not
 * faked, where there is no python3. A source check below still guards the shape
 * when the probe cannot run.
 */
describe.skipIf(!HAVE_PYTHON)("the server's fill branch, as Python runs it", () => {
  const probed = (() => {
    const out = execFileSync("python3", [FILL_PROBE], { encoding: "utf8" });
    return JSON.parse(out) as {
      [scenario: string]: {
        trace: string[];
        error: string | null;
        marked: boolean;
        result: { ok?: boolean; mask?: string; frame?: number } | null;
      };
    };
  })();

  it("resolves the node once and marks it before the value goes in", () => {
    expect(probed.masked.trace).toEqual([
      "frame.wait_for_selector",
      "handle.evaluate:mark",
      "handle.fill",
    ]);
    expect(probed.masked.result).toEqual({ ok: true, mask: "stylesheet", frame: 0 });
  });

  it("never re-resolves the selector for the fill", () => {
    // frame.fill(selector, ...) is the second resolution. It must not appear.
    expect(probed.masked.trace).not.toContain("frame.fill");
    expect(probed.plain.trace).not.toContain("frame.fill");
  });

  it("does not type the value when the marked node went away", () => {
    expect(probed.detached.marked).toBe(true);
    expect(probed.detached.trace).not.toContain("handle.fill");
    expect(probed.detached.error).toBe("RuntimeError");
  });

  it("does not type the value when the page defeated the mark", () => {
    // The CSP case: the mark was attempted and did not take, so nothing is
    // typed at all rather than typed in the clear.
    expect(probed.mask_blocked.trace).toEqual([
      "frame.wait_for_selector",
      "handle.evaluate:mark",
    ]);
    expect(probed.mask_blocked.trace).not.toContain("handle.fill");
    expect(probed.mask_blocked.result).toEqual({ ok: false, mask: "unmasked", frame: 0 });
  });

  it("clears a stale mark from a node it is filling with something visible", () => {
    expect(probed.plain.trace).toEqual([
      "frame.wait_for_selector",
      "handle.evaluate:unmark",
      "handle.fill",
    ]);
    expect(probed.plain.marked).toBe(false);
    expect(probed.plain.result).toEqual({ ok: true, frame: 0 });
  });
});

/** The same shape, asserted from source, so a python-less run still guards it. */
describe("the server's fill branch, as written", () => {
  const branch = (() => {
    const src = fs.readFileSync(SERVER_PY, "utf8");
    const m = /if action in \("click", "fill"\):([\s\S]*?)\n        if action == "locate"/.exec(src);
    if (!m) throw new Error("fill branch not found in server.py");
    return m[1];
  })();

  it("marks and fills through one handle, only when the device asked", () => {
    expect(branch).toContain('if cmd.get("mask"):');
    expect(branch).toContain("el.evaluate(MASK_JS)");
    expect(branch).toContain('el.fill(cmd["value"]');
    expect(branch.indexOf("el.evaluate(MASK_JS)")).toBeLessThan(branch.indexOf('el.fill(cmd["value"]'));
  });

  it("refuses to type when the mark did not take", () => {
    expect(branch).toContain('if state == "unmasked":');
    expect(branch.indexOf('if state == "unmasked":')).toBeLessThan(
      branch.indexOf('el.fill(cmd["value"]'),
    );
  });

  it("clears the mark on a fill that is not a secret", () => {
    expect(branch).toContain("el.evaluate(UNMASK_JS)");
  });
});

/** A `"""…"""` literal, lifted from the server so the test can't drift. */
function loadScript(name: string): (el: unknown) => unknown {
  const src = fs.readFileSync(SERVER_PY, "utf8");
  const m = new RegExp(`^${name} = """([\\s\\S]*?)"""$`, "m").exec(src);
  if (!m) throw new Error(`${name} literal not found in server.py`);
  return new Function(`return (${m[1]})`)() as (el: unknown) => unknown;
}

interface StubEl {
  attrs: Record<string, string>;
  style: {
    props: Record<string, string>;
    setProperty(k: string, v: string): void;
    removeProperty(k: string): void;
    webkitTextSecurity?: string;
  };
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

/**
 * Just enough DOM for the marker: no library, no rendering.
 *
 * `stylesheets` and `inlineProperties` are how a page's CSP is simulated. A
 * page whose style-src omits 'unsafe-inline' blocks a <style> element outright
 * (stylesheets: false) while leaving properties set directly on an element's
 * style object alone (inlineProperties: true) — per CSP Level 3 §6.1.13.3,
 * whose inline check covers style elements and style attributes only.
 */
function stubPage(
  opts: { stylesheets?: boolean; inlineProperties?: boolean } = {},
): { doc: StubDoc; el: () => StubEl } {
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
        attrs,
        tagName: "INPUT",
        type: "text",
        name: "cc-number",
        id: "",
        labels: [],
        value: "",
        options: [],
        style: {
          props,
          setProperty: (k: string, v: string) => {
            if (inlineProperties) props[k] = v;
          },
          removeProperty: (k: string) => {
            delete props[k];
          },
        },
        setAttribute(k: string, v: string) {
          attrs[k] = v;
        },
        removeAttribute(k: string) {
          delete attrs[k];
        },
        hasAttribute: (k: string) => k in attrs,
        getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
        ownerDocument: doc,
      } as StubEl;
    },
  };
}

describe("the mark the page ends up carrying", () => {
  const mark = loadScript("MASK_JS") as (el: StubEl) => string;
  const unmark = loadScript("UNMASK_JS") as (el: StubEl) => boolean;

  it("puts the attribute the forms scan looks for on the element", () => {
    const page = stubPage();
    const el = page.el();
    expect(mark(el)).toBe("stylesheet");
    expect(el.attrs).toEqual({ "data-domo-secret": "" });
  });

  it("injects the stylesheet once across repeated fills", () => {
    const page = stubPage();
    expect(mark(page.el())).toBe("stylesheet");
    expect(mark(page.el())).toBe("stylesheet");
    expect(mark(page.el())).toBe("stylesheet");
    expect(page.doc.styles.length).toBe(1);
    expect(page.doc.styles[0].textContent).toBe("[data-domo-secret]{-webkit-text-security:disc}");
  });

  it("adds one attribute and one style element on an ordinary page", () => {
    const page = stubPage();
    const el = page.el();
    mark(el);
    expect(Object.keys(el.attrs)).toEqual(["data-domo-secret"]);
    expect(page.doc.styles.length).toBe(1);
    expect(el.style.props).toEqual({});
  });

  it("falls back to the element's own style when a CSP blocks the stylesheet", () => {
    // style-src without 'unsafe-inline': the <style> is inert, so the mark is
    // not believed until the computed style agrees.
    const page = stubPage({ stylesheets: false });
    const el = page.el();
    expect(mark(el)).toBe("inline");
    expect(el.attrs).toEqual({ "data-domo-secret": "" });
    expect(el.style.props["-webkit-text-security"]).toBe("disc");
  });

  it("reports unmasked when neither route takes", () => {
    // Nothing the page will honour. The caller must not type into this.
    const page = stubPage({ stylesheets: false, inlineProperties: false });
    expect(mark(page.el())).toBe("unmasked");
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
    // The other half of a stale mark: `forms` keys on the attribute, so a node
    // that was a password and is now a username has to read as a username.
    const src = fs.readFileSync(SERVER_PY, "utf8");
    const m = /^FIELD_JS = """([\s\S]*?)"""$/m.exec(src);
    if (!m) throw new Error("FIELD_JS literal not found in server.py");
    const scan = new Function("document", `return (${m[1]})();`) as (
      doc: unknown,
    ) => { value: string; secret: boolean; filled: boolean }[];

    const page = stubPage();
    const el = page.el();
    mark(el);
    el.value = "jon@example.com";
    const [masked] = scan({ querySelectorAll: () => [el] });
    expect(masked.secret).toBe(true);
    expect(masked.value).toBe("");

    unmark(el);
    const [plain] = scan({ querySelectorAll: () => [el] });
    expect(plain.secret).toBe(false);
    expect(plain.value).toBe("jon@example.com");
  });
});
