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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSONValue, jv } from "@domo/protocol";
import { BrowserHost, BrowserSessions, CredentialBroker } from "@domo/device-core";
import { havePython, runProbe } from "./pythonProbe.js";

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
const HAVE_PYTHON = havePython();

interface Ctx {
  sessions: BrowserSessions;
  host: BrowserHost;
  events: { event: string; fields: { [k: string]: JSONValue } }[];
  dir: string;
  cmdLog: string;
  brokerLog: string;
}

let ctx: Ctx;

function makeCtx(serverEnv: Record<string, string> = {}, brokerEnv: Record<string, string> = {}): Ctx {
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
        descriptors: [
          { label: "username", hidden: false, custom: false, alias: false },
          { label: "password", hidden: true, custom: false, alias: false },
          { label: "shipping address", hidden: false, custom: true, alias: false },
        ],
        values: { username: "jon", password: "hunter2", "shipping address": "1 Elm St" },
      },
      {
        id: "C1",
        title: "Visa",
        category: "CREDIT_CARD",
        username: "",
        urls: [],
        descriptors: [
          { label: "number", hidden: true, custom: false, alias: false },
          { label: "code", hidden: true, custom: false, alias: false },
          { label: "cardholder name", hidden: false, custom: false, alias: false },
        ],
        values: { number: "4111111111111111", code: "737", "cardholder name": "Jon Doe" },
      },
      {
        id: "I1",
        title: "Home",
        category: "IDENTITY",
        username: "",
        urls: [],
        descriptors: [
          { label: "ssn", hidden: true, custom: false, alias: false },
          { label: "passport number", hidden: true, custom: false, alias: false },
          { label: "license number", hidden: false, custom: false, alias: false },
          { label: "address1", hidden: false, custom: false, alias: false },
          { label: "city", hidden: false, custom: false, alias: false },
        ],
        values: {
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
    env: { FAKE_BROKER_VAULT: vaultPath, ...brokerEnv },
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

/** Every command the device sent, values already redacted by the fixture. */
function commands(): { action: string; selector?: string; mask?: boolean; frame_token?: string }[] {
  return fs
    .readFileSync(ctx.cmdLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { action: string; selector?: string; mask?: boolean; frame_token?: string });
}

/**
 * The fill commands, projected to what these tests are about. The fixture has
 * already redacted the value; this keeps only the selector and the mask flag,
 * so neither an assertion nor a failure diff can carry anything else.
 */
function fills(): { selector: string; mask?: boolean }[] {
  return commands()
    .filter((c) => c.action === "fill")
    .map((c) => ("mask" in c ? { selector: c.selector!, mask: c.mask } : { selector: c.selector! }));
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

  it("refuses a field the vault does not offer instead of masking it", async () => {
    const handle = await session();
    const result = await ctx.sessions.command("agent-1", handle, {
      action: "fill_secret",
      selector: "#pass",
      item: "L1",
      field: "who-knows",
    });
    expect(jv(result).get("status").str).toBe("error");
    expect(jv(result).get("error").str).toContain("does not offer a field called who-knows");
    // Refused before anything was typed: no fill reached the browser.
    expect(fills()).toEqual([]);
    expect(ctx.events.at(-1)?.event).toBe("credential_denied");
  });

  it("refuses the fill when the vault cannot answer at all", async () => {
    const handle = await session();
    const broken = path.join(ctx.dir, "broken-broker.cjs");
    fs.writeFileSync(
      broken,
      'process.stderr.write(JSON.stringify({ type: "VaultLocked", message: "the vault is locked" }) + "\\n");\n' +
        "process.exit(1);\n",
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
    // Nothing typed, and the refusal is recorded.
    expect(fills().length).toBe(before);
    expect(ctx.events.at(-1)?.event).toBe("credential_denied");
  });

  it("asks the vault once per fill, and never asks it to describe anything", async () => {
    // The value and its concealment arrive together, so there is no second
    // question to cache the answer to and no describe in the release path.
    const handle = await session();
    for (const selector of ["#pass", "#pass2", "#pass3"]) {
      await ctx.sessions.command("agent-1", handle, {
        action: "fill_secret",
        selector,
        item: "L1",
        field: "password",
      });
    }
    const lines = fs.readFileSync(ctx.brokerLog, "utf8").trim().split("\n");
    expect(fills().length).toBe(3);
    expect(lines.filter((l) => l.includes("DESCRIBED"))).toEqual([]);
    expect(lines.filter((l) => l.includes("RELEASED")).length).toBe(3);
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

  it("refuses to show the page when a concealed field will not stay covered", async () => {
    // The browser re-applies every mark before an observation and says so when
    // one will not take. Handing over the picture anyway is how the value ends
    // up in the transcript.
    await ctx.host.shutdown();
    ctx = makeCtx({ FAKE_REMASK_FAILS: "1" });
    const handle = await session();
    await ctx.sessions.command("agent-1", handle, {
      action: "fill_secret", selector: "#pass", item: "L1", field: "password",
    });
    for (const action of ["screenshot", "forms"]) {
      const result = await ctx.sessions.command("agent-1", handle, { action });
      expect(jv(result).get("status").str, action).toBe("error");
      expect(jv(result).get("error").str).toContain("will not let it be hidden on screen");
      // No picture, no field list — nothing of the page comes back.
      expect(jv(result).get("data_b64").str).toBeNull();
      expect(jv(result).get("forms").value ?? null).toBeNull();
    }
    expect(ctx.events.filter((e) => e.event === "credential_mask_failed").length).toBe(2);
  });

  it("tells the browser which document it approved", async () => {
    const handle = await session();
    await ctx.sessions.command("agent-1", handle, {
      action: "fill_secret", selector: "#card-number", item: "C1", field: "number",
    });
    // The fill carries the document's token, not just the frame index — an
    // index is not an identity once the site can swap the frame out, and a URL
    // is not one either once an SPA can rewrite it.
    const fill = commands().find((c) => c.action === "fill")!;
    expect(fill.frame_token).toBe("doc-card");
  });

  it("refuses when the browser says the frame moved", async () => {
    await ctx.host.shutdown();
    ctx = makeCtx({ FAKE_FRAME_MOVED: "1" });
    const handle = await session();
    const before = ctx.events.length;
    const result = await ctx.sessions.command("agent-1", handle, {
      action: "fill_secret", selector: "#card-number", item: "C1", field: "number",
    });
    expect(jv(result).get("status").str).toBe("error");
    expect(jv(result).get("error").str).toContain("was replaced while the vault");
    expect(ctx.events.slice(before).at(-1)).toEqual({
      event: "credential_denied",
      fields: {
        session: handle,
        item: "C1",
        field: "number",
        origin: "payframe.example",
        selector: "#card-number",
        reason: "the frame was replaced after its origin was approved",
      },
    });
    expect(JSON.stringify(result)).not.toContain("4111");
  });

  it("does not let a fill outlive the session that approved it", async () => {
    // Asking the vault takes long enough for the session to end underneath the
    // fill. The browser is shared, so a value released for a session that has
    // gone would be typed into whatever the next one has on screen.
    await ctx.host.shutdown();
    ctx = makeCtx({}, { FAKE_BROKER_DELAY_MS: "600" });
    const handle = await session();
    const inFlight = ctx.sessions.command("agent-1", handle, {
      action: "fill_secret", selector: "#pass", item: "L1", field: "password",
    });
    await new Promise((r) => setTimeout(r, 150));
    await ctx.sessions.close(handle, "agent");
    const reopened = await ctx.sessions.open("i9", "agent-2", ["other.example"], false);
    expect(jv(reopened).get("session").str).not.toBe(handle);

    const result = await inFlight;
    expect(jv(result).get("status").str).toBe("error");
    expect(jv(result).get("error").str).toContain("session ended while the vault");
    // Nothing reached the browser at all — not the old session's, not the new
    // session's.
    expect(fills()).toEqual([]);
    expect(ctx.events.at(-1)).toEqual({
      event: "credential_denied",
      fields: {
        session: handle,
        item: "L1",
        field: "password",
        origin: "pizza.example",
        selector: "#pass",
        reason: "the session ended while the vault was being asked",
      },
    });
    expect(JSON.stringify(ctx.events)).not.toContain("hunter2");
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
    return runProbe<{
      [scenario: string]: {
        trace: string[];
        error: string | null;
        marked: boolean;
        result: { ok?: boolean; mask?: string; frame?: number; frame_url?: string; frame_token?: string } | null;
        value_kept: boolean;
        ledgered: boolean;
        typed_delay: number | null;
        typed_len: number | null;
        node_len: number;
        asked_len: number;
        drops_keys?: boolean;
      };
    } & {
      constants: { typed_chars: number };
      ledger: {
        [scenario: string]: {
          steps: { step: string; result: { ok?: boolean; mask?: string } | null }[];
          tracked: string[];
          marked: { [selector: string]: boolean };
          sibling_marked: boolean;
        };
      };
    }>(FILL_PROBE);
  })();

  it("resolves the node once and marks it before the value goes in", () => {
    expect(probed.masked.trace).toEqual([
      "frame.wait_for_selector",
      "handle.evaluate:mark",
      "handle.assign",
      "handle.type",
    ]);
    expect(probed.masked.result).toEqual({ ok: true, mask: "stylesheet", frame: 0 });
  });

  it("types the value in rather than assigning it", () => {
    // The bug this replaced: `el.fill()` sets `.value` and fires one `input`,
    // so a password box went from empty to complete with no keydown/keyup at
    // all. Interrogation-style bot defenses read exactly that (issue #86).
    expect(probed.plain.typed_delay).toBeGreaterThan(0);
    expect(probed.masked.typed_delay).toBeGreaterThan(0);
  });

  it("assigns into a widget whose value is not the characters it is given", () => {
    // A date, number, colour or range input composes its value out of
    // something other than the string: typing "2026-08-19" into one lands the
    // wrong day or nothing at all, where assigning it works. None of those are
    // what an interrogating defense samples, so nothing is lost by assigning.
    expect(probed.not_typeable.trace).not.toContain("handle.type");
    expect(probed.not_typeable.typed_len).toBeNull();
    expect(probed.not_typeable.node_len).toBe(probed.not_typeable.asked_len);
    expect(probed.not_typeable.result).toEqual({ ok: true, frame: 0 });
  });

  it("still marks a widget the vault masks, and still ledgers it", () => {
    // The question is asked after the mark has gone on, so the branch that
    // assigns rather than types starts from a node that is already concealed.
    const masked = probed.not_typeable_masked;
    expect(masked.trace).not.toContain("handle.type");
    expect(masked.trace).toContain("handle.evaluate:mark");
    expect(masked.result).toEqual({ ok: true, mask: "stylesheet", frame: 0 });
    expect(masked.marked).toBe(true);
    expect(masked.ledgered).toBe(true);
    expect(masked.node_len).toBe(masked.asked_len);
  });

  it("assigns the value outright when the keys did not compose it", () => {
    // A field can take the keys and sanitise some of them away — a number
    // input handed something that is not a number does exactly that. Reporting
    // that as a fill would tell the caller a credential landed when it did
    // not, so the value is assigned instead: that either lands it or raises,
    // which is what this did before there were keystrokes at all.
    expect(probed.keys_dropped.trace).toEqual([
      "frame.wait_for_selector",
      "handle.assign",
      "handle.type",
      "handle.assign",
      "handle.evaluate:unmark",
    ]);
    // The ordinary case does not pay for the fallback, and neither does a
    // field that REFORMATS what it took — a card number that spaces itself out
    // holds something other than what was asked for on purpose, and the keys
    // it took are not thrown away to re-assign over them.
    expect(probed.plain.trace.filter((t) => t === "handle.assign")).toHaveLength(1);
    expect(probed.long_value.trace.filter((t) => t === "handle.assign")).toHaveLength(1);
  });

  it("fails loudly when the field will not take the value at all", () => {
    // The end of that path: the keys were dropped and the assignment is
    // refused too. Nothing landed, so the caller hears about it rather than
    // being told a credential went in — and because something was concealed
    // here, the node stays marked and ledgered rather than being handed back
    // to the forms scan.
    const run = probed.keys_dropped_unfillable;
    expect(run.trace.at(-1)).toBe("handle.assign-failed");
    expect(run.error).toBe("RuntimeError");
    expect(run.marked).toBe(true);
    expect(run.ledgered).toBe(true);
  });

  it("types the tail of a value too long to type whole, and lands the rest", () => {
    // Typing cannot be allowed to grow with the length of the value, so the
    // bulk is assigned and only the tail is typed. What matters is that the
    // whole value still lands: the head is not dropped, it just does not
    // arrive as keystrokes.
    expect(probed.long_value.typed_len).toBe(probed.constants.typed_chars);
    expect(probed.long_value.node_len).toBe(probed.long_value.asked_len);
    expect(probed.long_value.asked_len).toBeGreaterThan(probed.constants.typed_chars);
    expect(probed.long_value.typed_delay).toBe(probed.plain.typed_delay);
    // A credential is shorter than the tail, so all of it is typed.
    expect(probed.plain.asked_len).toBeLessThanOrEqual(probed.constants.typed_chars);
    expect(probed.plain.typed_len).toBe(probed.plain.asked_len);
    expect(probed.plain.node_len).toBe(probed.plain.asked_len);
    expect(probed.long_value.result).toEqual({ ok: true, frame: 0 });
  });

  it("hands the device an identity to check the fill against", () => {
    // `locate` reports both: the url the device checks an origin against, and
    // the document token the fill is checked against when the value comes back.
    expect(probed.located.result).toEqual({
      frame: 0,
      frame_url: "https://pizza.example/login",
      frame_token: "doc-1",
    });
  });

  it("lets a fill through when only the address bar moved", () =>{
    // An SPA rewriting its URL during the vault lookup has replaced nothing:
    // same document, same node, same token. Comparing URLs refused this and
    // sent the owner to fill their own password in by hand.
    const spa = probed.route_changed_during_lookup;
    expect(spa.result).toEqual({ ok: true, mask: "stylesheet", frame: 0 });
    expect(spa.marked).toBe(true);
  });

  it("refuses when the frame behind the index is no longer the approved one", () =>{
    // The device checks an origin, then goes away to fetch the value. A site
    // can swap that iframe out in between, and the index still points at
    // something — so the browser is told which document was approved and
    // compares it against the node it actually resolved.
    // A replaced frame is a new document, so a new token — this is the round-4
    // property, and comparing tokens rather than urls must not weaken it.
    const moved = probed.frame_moved;
    expect(moved.result).toEqual({ ok: false, mask: "moved", frame: 0 });
    expect(moved.trace).toEqual(["frame.wait_for_selector"]);
    expect(moved.marked).toBe(false);
    expect(moved.value_kept).toBe(true);
    // Same document, same check, and it proceeds.
    expect(probed.frame_same.result).toEqual({ ok: true, mask: "stylesheet", frame: 0 });
  });

  it("takes the mark back off when the fill it went with never landed", () => {
    // Marked, then the fill timed out over a field that already held an
    // ordinary value. Left alone, that field is tagged and blanked from
    // `forms` for the life of the page.
    const orphan = probed.orphan_mark;
    expect(orphan.trace).toEqual([
      "frame.wait_for_selector",
      "handle.evaluate:mark",
      "handle.assign-failed",
      "handle.evaluate:unmark",
    ]);
    expect(orphan.marked).toBe(false);
    expect(orphan.value_kept).toBe(true);
  });

  // What a fill that did not land leaves behind. The rule is "put the node back
  // as it was found, unless something landed in it" — the cases below are the
  // ways that can play out.
  it.each([
    {
      what: "nothing landed: the mark comes off",
      scenario: "orphan_mark",
      marked: false, ledgered: false, valueKept: true,
    },
    {
      what: "part of it landed: the mark stays and is ledgered",
      scenario: "orphan_mark_partial",
      marked: true, ledgered: true, valueKept: false,
    },
    {
      what: "what landed collides with what was there: still not 'unchanged'",
      scenario: "orphan_mark_collision",
      marked: true, ledgered: true, valueKept: false,
    },
    {
      what: "the node was already masked: the mark was never ours to remove",
      scenario: "orphan_mark_premarked",
      marked: true, ledgered: false, valueKept: true,
    },
    {
      what: "a long secret's head landed and its keys did not: still ledgered",
      scenario: "orphan_mark_long",
      marked: true, ledgered: true, valueKept: false,
    },
    {
      what: "the clear landed and no key did: an empty node concealed nothing",
      scenario: "typing_never_started",
      marked: false, ledgered: false, valueKept: false,
    },
  ])("$what", ({ scenario, marked, ledgered, valueKept }) => {
    const run = probed[scenario];
    expect(run.marked).toBe(marked);
    expect(run.ledgered).toBe(ledgered);
    expect(run.value_kept).toBe(valueKept);
  });

  it("does not type the value when the marked node went away", () => {
    expect(probed.detached.trace).not.toContain("handle.type");
    expect(probed.detached.trace).toContain("handle.assign-failed");
    expect(probed.detached.error).toBe("RuntimeError");
    // Nothing landed, so the mark does not survive either — a node that went
    // away mid-fill is put back as it was found, same as any other fill that
    // did not happen.
    expect(probed.detached.marked).toBe(false);
    expect(probed.detached.value_kept).toBe(true);
  });

  it("does not type the value when the page defeated the mark", () => {
    // The CSP case: the mark was attempted and did not take, so nothing is
    // typed at all rather than typed in the clear.
    expect(probed.mask_blocked.trace).toEqual([
      "frame.wait_for_selector",
      "handle.evaluate:mark",
    ]);
    expect(probed.mask_blocked.trace).not.toContain("handle.assign");
    expect(probed.mask_blocked.trace).not.toContain("handle.type");
    expect(probed.mask_blocked.result).toEqual({ ok: false, mask: "unmasked", frame: 0 });
  });

  it("keeps a concealed field tracked, and lets the observation through", () => {
    const kept = probed.ledger.kept;
    expect(kept.tracked).toEqual(["doc-1:#pass"]);
    expect(kept.marked["#pass"]).toBe(true);
    expect(kept.steps.at(-1)!.result).toEqual({});
  });

  it("forgets a field overwritten with something visible", () => {
    // This ledger used to live on the device and was never pruned, so a
    // selector reused for an address kept being re-marked before every
    // observation — hiding ordinary data, and undoing the unmask on the way.
    const over = probed.ledger.visible_overwrite;
    expect(over.tracked).toEqual([]);
    expect(over.marked["#pass"]).toBe(false);
  });

  it("finds a masked field again after the frames above it are renumbered", () => {
    // The ledger was keyed on a frame INDEX. Removing an iframe above this one
    // renumbers everything below it, so the mark went back on whatever
    // inherited the number while the field that needed it went bare into the
    // next screenshot. A document token names one document and never another.
    const shifted = probed.ledger.sibling_frame_removed;
    expect(shifted.tracked).toEqual(["doc-1:#pass"]);
    expect(shifted.marked["#pass"]).toBe(true);
  });

  it("forgets a field whose own frame navigated away", () => {
    // For a child frame, "navigated" and "removed" are the same sentence: the
    // document it was filled into is not on the page any more.
    const gone = probed.ledger.child_frame_navigated;
    expect(gone.tracked).toEqual([]);
    // And the same selector in the frame next door is left alone. Looking one
    // up by selector without pinning the document would mark that instead.
    expect(gone.sibling_marked).toBe(false);
  });

  it("never marks the same selector in a different document", () => {
    // The advert frame carries a `#pass` of its own. Every scenario leaves it
    // untouched, because a target names a document as well as a selector.
    for (const [name, run] of Object.entries(probed.ledger)) {
      expect(run.sibling_marked, name).toBe(false);
    }
  });

  it("forgets everything when the page navigates", () => {
    // A page that has moved is not the page anything was filled on.
    expect(probed.ledger.navigated.tracked).toEqual([]);
  });

  it("keeps the marks across a route change inside one document", () => {
    // An SPA moving from /step1 to /step2 replaces neither the document nor the
    // fields on it. Treating that as a new page threw the record away, and a
    // re-rendered controlled input then kept the secret and lost the marker —
    // so the very next screenshot showed it.
    const spa = probed.ledger.same_document_route;
    expect(spa.tracked).toEqual(["doc-1:#pass"]);
    expect(spa.marked["#pass"]).toBe(true);
    expect(spa.steps.at(-1)!.result).toEqual({});
  });

  it("refuses the observation when a mark will not go back on", () => {
    expect(probed.ledger.wont_take.steps.at(-1)!.result).toEqual({ ok: false, mask: "unmasked" });
  });

  it("drops a field whose node has gone, and shows the page", () => {
    const gone = probed.ledger.node_gone;
    expect(gone.tracked).toEqual([]);
    expect(gone.steps.at(-1)!.result).toEqual({});
  });

  it("clears a stale mark only once the new value is in", () => {
    // Unmarking first would leave the previous secret in the node with nothing
    // hiding it if the fill then timed out.
    expect(probed.plain.trace).toEqual([
      "frame.wait_for_selector",
      "handle.assign",
      "handle.type",
      "handle.evaluate:unmark",
    ]);
    expect(probed.plain.marked).toBe(false);
    expect(probed.plain.result).toEqual({ ok: true, frame: 0 });
  });

  it("keeps the mark on when a visible fill fails", () => {
    // The node still holds the previous secret; the mark is what stops it being
    // read off the screen, so it stays until something replaces the value.
    expect(probed.plain_failed.trace).toEqual([
      "frame.wait_for_selector",
      "handle.assign-failed",
    ]);
    expect(probed.plain_failed.trace).not.toContain("handle.evaluate:unmark");
    expect(probed.plain_failed.marked).toBe(true);
    expect(probed.plain_failed.error).toBe("RuntimeError");
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

describe("which fields take real keys", () => {
  const typeable = loadScript("TYPEABLE_JS") as (el: {
    tagName: string;
    type?: string;
  }) => boolean;

  // Which fields get real keys and which keep the assignment they always had.
  // Asserted against the literal `server.py` evaluates, because the list IS the
  // behavior — the probe stubs the answer, so only this can catch an edit to it.
  it.each([
    { what: "a text box", el: { tagName: "INPUT", type: "text" }, typed: true },
    { what: "a password box", el: { tagName: "INPUT", type: "password" }, typed: true },
    // A one-time code or a CVV is routinely declared this way, and it composes
    // its value from the keys exactly as a text box does.
    { what: "a number field", el: { tagName: "INPUT", type: "number" }, typed: true },
    { what: "a tel field", el: { tagName: "INPUT", type: "tel" }, typed: true },
    { what: "an email field", el: { tagName: "INPUT", type: "email" }, typed: true },
    { what: "a search field", el: { tagName: "INPUT", type: "search" }, typed: true },
    { what: "a url field", el: { tagName: "INPUT", type: "url" }, typed: true },
    // An <input> with no type attribute reports "text", so there is no empty
    // case to allow for — and this is the test that says so.
    { what: "an input with no type", el: { tagName: "INPUT", type: "text" }, typed: true },
    { what: "a textarea", el: { tagName: "TEXTAREA" }, typed: true },
    { what: "a contenteditable", el: { tagName: "DIV" }, typed: true },
    // Typing "2026-08-19" into one of these lands 6081-02-02, silently.
    { what: "a date field", el: { tagName: "INPUT", type: "date" }, typed: false },
    {
      what: "a datetime-local field",
      el: { tagName: "INPUT", type: "datetime-local" },
      typed: false,
    },
    // These do take their characters; they are assigned because no defense
    // samples them, so there is nothing to weigh against the path they had.
    { what: "a time field", el: { tagName: "INPUT", type: "time" }, typed: false },
    { what: "a month field", el: { tagName: "INPUT", type: "month" }, typed: false },
    { what: "a week field", el: { tagName: "INPUT", type: "week" }, typed: false },
    // Not textual at all: these refuse keys outright.
    { what: "a colour picker", el: { tagName: "INPUT", type: "color" }, typed: false },
    { what: "a range slider", el: { tagName: "INPUT", type: "range" }, typed: false },
  ])("$what is $typed to type into", ({ el, typed }) => {
    expect(typeable(el)).toBe(typed);
  });
});

describe("the mark the page ends up carrying", () => {
  const mark = loadScript("MASK_JS") as (el: StubEl) => string;
  const unmark = loadScript("UNMASK_JS") as (el: StubEl) => boolean;

  it("puts the attribute the forms scan looks for on the element, and nothing else", () => {
    const page = stubPage();
    const el = page.el();
    expect(mark(el)).toBe("stylesheet");
    expect(el.attrs).toEqual({ "data-domo-secret": "" });
    // One attribute, one stylesheet, no inline fallback needed on a page that
    // allows the stylesheet.
    expect(page.doc.styles.length).toBe(1);
    expect(el.style.props).toEqual({});
  });

  it("injects the stylesheet once across repeated fills", () => {
    const page = stubPage();
    expect(mark(page.el())).toBe("stylesheet");
    expect(mark(page.el())).toBe("stylesheet");
    expect(mark(page.el())).toBe("stylesheet");
    expect(page.doc.styles.length).toBe(1);
    expect(page.doc.styles[0].textContent).toBe("[data-domo-secret]{-webkit-text-security:disc}");
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

  it("takes its own tag back off when the mark did not take", () => {
    // The tag goes on before the mark is verified. Leaving it on a field that
    // was never masked would withhold an ordinary value from `forms` for the
    // life of the page — a field the agent was told to check, silently blanked.
    const page = stubPage({ stylesheets: false, inlineProperties: false });
    const el = page.el();
    expect(mark(el)).toBe("unmasked");
    expect(el.attrs).toEqual({});
    expect(el.style.props).toEqual({});
  });

  it("leaves the tag alone on a field that was already masked", () => {
    // Same failure, different node: this one is holding a secret already, so
    // taking its tag off would expose it.
    const page = stubPage({ stylesheets: false, inlineProperties: false });
    const el = page.el();
    el.setAttribute("data-domo-secret", "");
    expect(mark(el)).toBe("unmasked");
    expect(el.attrs).toEqual({ "data-domo-secret": "" });
  });

  it("reports unmasked when neither route takes", () =>{
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
