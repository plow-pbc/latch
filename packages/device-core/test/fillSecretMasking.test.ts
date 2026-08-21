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
import { BrowserHostConfig, BrowserSessions, CredentialBroker } from "@domo/device-core";
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
  browsers: BrowserHostConfig;
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
  const browsers = {
    command: [process.execPath, FAKE_SERVER],
    headed: false,
    screenshotsDir: path.join(dir, "shots"),
    env: { FAKE_CMD_LOG: cmdLog, ...serverEnv },
    audit: () => {},
  };
  const credentials = new CredentialBroker({
    command: [process.execPath, FAKE_BROKER],
    env: { FAKE_BROKER_VAULT: vaultPath, ...brokerEnv },
    auditPath: brokerLog,
  });
  const sessions = new BrowserSessions(
    browsers,
    credentials,
    (event, fields) => events.push({ event, fields }),
  );
  return { sessions, browsers, events, dir, cmdLog, brokerLog };
}

/** What the audit calls this session — read off the open event, not recomputed. */
const audited = (): string =>
  ctx.events.find((e) => e.event === "browser_session_opened")!.fields.session as string;

/** Open a session already approved for both items and both origins. */
async function session(): Promise<string> {
  const opened = await ctx.sessions.open("i1", "agent-1", ["pizza.example", "payframe.example"], false);
  const handle = (opened as { session: string }).session;
  ctx.sessions.extend("i2", handle, [], ["L1", "C1", "I1"], false);
  await ctx.sessions.command(handle, {
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
  await ctx.sessions.closeAll("teardown");
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

describe("fill_secret marking", () => {
  it("asks the browser to mark a field the vault masks", async () => {
    const handle = await session();
    const result = await ctx.sessions.command(handle, {
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
    await ctx.sessions.command(handle, {
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
      await ctx.sessions.command(handle, {
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
    const result = await ctx.sessions.command(handle, {
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
      ctx.browsers,
      new CredentialBroker({ command: [process.execPath, broken] }),
      (event, fields) => ctx.events.push({ event, fields }),
    );
    const opened = await sessions.open("i1", "agent-1", ["pizza.example"], false);
    const h = (opened as { session: string }).session;
    sessions.extend("i2", h, [], ["L1"], false);
    await sessions.command(h, { action: "goto", url: "https://pizza.example/login" });
    const before = fills().length;
    const result = await sessions.command(h, {
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
      await ctx.sessions.command(handle, {
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
      const result = await ctx.sessions.command(handle, {
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
    await ctx.sessions.closeAll("teardown");
    ctx = makeCtx({ FAKE_CSP_BLOCKS_MASK: "1" });
    const handle = await session();
    const before = ctx.events.length;
    const result = await ctx.sessions.command(handle, {
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
          session: audited(),
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
    await ctx.sessions.closeAll("teardown");
    ctx = makeCtx({ FAKE_CSP_BLOCKS_MASK: "1" });
    const handle = await session();
    const result = await ctx.sessions.command(handle, {
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
    await ctx.sessions.closeAll("teardown");
    ctx = makeCtx({ FAKE_REMASK_FAILS: "1" });
    const handle = await session();
    await ctx.sessions.command(handle, {
      action: "fill_secret", selector: "#pass", item: "L1", field: "password",
    });
    for (const action of ["screenshot", "forms"]) {
      const result = await ctx.sessions.command(handle, { action });
      expect(jv(result).get("status").str, action).toBe("error");
      expect(jv(result).get("error").str).toContain("will not let it be hidden on screen");
      // No picture, no field list — nothing of the page comes back.
      expect(jv(result).get("data_b64").str).toBeNull();
      expect(jv(result).get("forms").value ?? null).toBeNull();
    }
    expect(ctx.events.filter((e) => e.event === "credential_mask_failed").length).toBe(2);

    // A refusal that settles into that refused observation is not lost with it:
    // the observation is the device's to withhold, what the page's requests did
    // is the agent's to know.
    await ctx.sessions.command(handle, { action: "click", selector: "#blocked-later" });
    const refused = jv(await ctx.sessions.command(handle, { action: "screenshot" }));
    expect(refused.get("status").str).toBe("error");
    expect(refused.get("failed_requests").value).toEqual([
      { status: 401, method: "GET", host: "pizza.example" },
    ]);
  });

  it("tells the browser which document it approved", async () => {
    const handle = await session();
    await ctx.sessions.command(handle, {
      action: "fill_secret", selector: "#card-number", item: "C1", field: "number",
    });
    // The fill carries the document's token, not just the frame index — an
    // index is not an identity once the site can swap the frame out, and a URL
    // is not one either once an SPA can rewrite it.
    const fill = commands().find((c) => c.action === "fill")!;
    expect(fill.frame_token).toBe("doc-card");
  });

  // The vault fills unconcealed fields too — an address, a username — and those
  // took the same path. Both must name the cap rather than send the agent back
  // to check a selector that was right.
  it.each([
    { what: "a concealed field", selector: "#card-number", item: "C1", field: "number",
      origin: "payframe.example", held: "4111111111111111" },
    { what: "a field the vault does not conceal", selector: "#card-name", item: "C1",
      field: "cardholder name", origin: "payframe.example", held: "Jon Doe" },
  ])("tells the agent the cap when $what will not hold the value", async ({
    selector, item, field, origin, held,
  }) => {
    await ctx.sessions.closeAll("teardown");
    ctx = makeCtx({ FAKE_TOO_LONG: "16" });
    const handle = await session();
    const before = ctx.events.length;
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selector, item, field,
    });
    expect(jv(result).get("status").str).toBe("error");
    // The cap, not "check the selector" — the selector was right.
    expect(jv(result).get("error").str).toContain("holds only 16 characters");
    expect(jv(result).get("error").str).not.toContain("check the selector");
    // `credential_fill_failed`, not `credential_denied` — the badge ladder
    // reads the latter as "Scope blocked", and nothing about scope failed here.
    expect(ctx.events.slice(before).at(-1)).toEqual({
      event: "credential_fill_failed",
      fields: {
        session: audited(), item, field, origin, selector,
        reason: "the field holds only 16 characters",
      },
    });
    // Whatever this row's value is, it is the one thing that does not travel.
    expect(JSON.stringify(result)).not.toContain(held);
  });

  // The agent's own `fill` takes the same refusal. Its regression is the worst
  // shape available — a result that falls through as `status: "completed"`
  // carrying `ok: false` tells the agent the fill happened while nothing was
  // typed — which is why it is thrown rather than returned.
  it("refuses the agent's own fill rather than reporting it completed", async () => {
    await ctx.sessions.closeAll("teardown");
    ctx = makeCtx({ FAKE_TOO_LONG: "16" });
    const handle = await session();
    const before = ctx.events.length;
    const result = await ctx.sessions.command(handle, {
      action: "fill", selector: "#card-name", value: "a value longer than sixteen",
    });
    expect(jv(result).get("status").str).toBe("error");
    expect(jv(result).get("error").str).toContain("holds only 16 characters");
    // And the owner's log tells it from a fill that landed, through the record
    // every failed command already writes rather than an event of its own.
    // One line, carrying the reason: the refusal is raised before the ordinary
    // command record is written, so the owner does not get a bare line and then
    // a second one explaining it.
    const written = ctx.events.slice(before).filter((e) => e.event === "browser_command");
    expect(written).toHaveLength(1);
    expect(written[0].fields.error).toContain("holds only 16 characters");
  });

  it("refuses when the browser says the frame moved", async () => {
    await ctx.sessions.closeAll("teardown");
    ctx = makeCtx({ FAKE_FRAME_MOVED: "1" });
    const handle = await session();
    const before = ctx.events.length;
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selector: "#card-number", item: "C1", field: "number",
    });
    expect(jv(result).get("status").str).toBe("error");
    expect(jv(result).get("error").str).toContain("was replaced while the vault");
    expect(ctx.events.slice(before).at(-1)).toEqual({
      event: "credential_denied",
      fields: {
        session: audited(),
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
    await ctx.sessions.closeAll("teardown");
    ctx = makeCtx({}, { FAKE_BROKER_DELAY_MS: "600" });
    const handle = await session();
    const inFlight = ctx.sessions.command(handle, {
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
        session: audited(),
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
    await ctx.sessions.command(handle, {
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
    const masked = await ctx.sessions.command(handle, {
      action: "fill_secret",
      selector: "#pass",
      item: "L1",
      field: "password",
    });
    const plain = await ctx.sessions.command(handle, {
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
        fields: { session: audited(), item: "L1", field: "password", origin: "pizza.example" },
      },
      {
        event: "credential_filled",
        fields: { session: audited(), item: "L1", field: "shipping address", origin: "pizza.example" },
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
        type_calls: number;
        key_timeout_max: number | null;
        key_timeout_min: number | null;
        node_len: number;
        asked_len: number;
      };
    } & {
      constants: {
        typed_chars: number;
        action_timeout_ms: number;
        typing_max_ms: number;
      };
      two_frames: {
        error: string | null;
        result: unknown;
        second_len: number;
        first_changed: boolean;
        trace: string[];
      };
      ledger: {
        [scenario: string]: {
          steps: { step: string; result: { ok?: boolean; mask?: string } | null }[];
          tracked: string[];
          marked: { [selector: string]: boolean };
          sibling_marked: boolean;
        };
      };
      ranked: { error: string | null; tried: number };
      ranked_only_gone: { error: string | null; tried: number };
      ranked_gone_first: { error: string | null; tried: number };
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

  // A field caps what it will hold, and the two ways of putting a value in fail
  // differently: typing is clipped to the cap, an assignment lands whole into a
  // field a person could only have filled to the cap. Both submit something
  // other than what was asked for, so neither is allowed to happen — and the
  // node is left exactly as it was found either way.
  it.each([
    { what: "a concealed fill", scenario: "capped_secret", cap: 4 },
    { what: "a fill the vault does not conceal", scenario: "capped_plain", cap: 4 },
    { what: "a field that holds nothing", scenario: "zero_cap", cap: 0 },
    { what: "a value whose emoji are two code units each", scenario: "astral_over_cap", cap: 4 },
  ])("refuses $what and does not touch the node", ({ scenario, cap }) => {
    const probe = probed[scenario];
    // One shape for every one of them: the vault fills unconcealed fields too,
    // and their failure text is swallowed the same way, so there is one answer
    // rather than two. The cap rides along because the device renders it.
    expect(probe.result).toEqual({ ok: false, mask: "too_long", cap, frame: 0 });
    expect(probe.error).toBeNull();
    // Resolved, and nothing after it: no fill, no mark to strip, nothing
    // half-written for a later screenshot to catch.
    expect(probe.trace).toEqual(["frame.wait_for_selector"]);
    expect(probe.marked).toBe(false);
    expect(probe.value_kept).toBe(true);
    expect(probe.ledgered).toBe(false);
  });

  // How the refusal is REPORTED differs because how it is heard does: a visible
  // fill's failure text reaches the agent, a secret's never does, so that one
  // comes back as a shape the device reads and turns into its own message.
  // A cap can move under a fill already in progress — a card-number input
  // lowers `maxlength` once the first digits identify the brand, 15 for Amex
  // against 16 for the rest — so the value is admitted, the keys are clipped,
  // and the repair that assigns has to ask the field again rather than trust
  // the answer the fill was admitted on.
  it.each([
    { what: "an ordinary fill", scenario: "cap_lowered_mid_fill" },
    { what: "a concealed fill", scenario: "cap_lowered_mid_fill_masked" },
    { what: "an ordinary fill whose clipped keys landed", scenario: "cap_lowered_keys_landed" },
    { what: "a concealed fill whose clipped keys landed", scenario: "cap_lowered_keys_landed_masked" },
  ])("refuses $what when the page lowers the cap mid-fill", ({ scenario }) => {
    expect(probed[scenario].result).toEqual({
      ok: false, mask: "too_long", cap: 4, frame: 0,
    });
    // The refusal leaves NOTHING in the page. By the time the cap moves, the
    // head assignment has already destroyed what the field held and the keys
    // that landed are a prefix of the secret — on an unconcealed vault fill
    // that would be a legible partial credential sitting under a result that
    // says the field was not filled.
    expect(probed[scenario].node_len).toBe(0);
    // And with nothing there, nothing stays concealed or tracked.
    expect(probed[scenario].marked).toBe(false);
    expect(probed[scenario].ledgered).toBe(false);
  });

  it("keeps the cap answer when the field cannot even be cleared", () => {
    // The page that moved the cap can detach the node along with it. The
    // clear's own failure must not replace the refusal on the way out — the
    // caller would lose the cap and fall back on "check the selector", which is
    // the message this whole path exists to stop producing.
    expect(probed.cap_lowered_clear_fails.result).toEqual({
      ok: false, mask: "too_long", cap: 4, frame: 0,
    });
    // And the clipped prefix really is still there: the honest outcome, and the
    // reason no message about this refusal claims what the field holds.
    expect(probed.cap_lowered_clear_fails.node_len).toBe(4);
  });

  it("still repairs dropped keys when the cap did not move", () => {
    // The contrast that keeps the refusal from swallowing the repair path:
    // same dropped keys, same assignment, cap unchanged — it lands.
    expect(probed.keys_dropped.result).toEqual({ ok: true, frame: 0 });
    expect(probed.keys_dropped.node_len).toBe(probed.keys_dropped.asked_len);
  });

  it("fills a value exactly as long as the field's cap", () => {
    // The boundary the check must not be off by one on: this one fits.
    expect(probed.at_cap.error).toBeNull();
    expect(probed.at_cap.result).toEqual({ ok: true, frame: 0 });
  });

  it("types the value in rather than assigning it", () => {
    // The bug this replaced: `el.fill()` sets `.value` and fires one `input`,
    // so a password box went from empty to complete with no keydown/keyup at
    // all. Interrogation-style bot defenses read exactly that (issue #86).
    expect(probed.plain.typed_delay).toBeGreaterThan(0);
    expect(probed.masked.typed_delay).toBeGreaterThan(0);
  });

  // One call per character, so the node is refocused before each. A segmented
  // one-time-code control moves focus to the next box on every `input` event,
  // and one `type(tail)` call sends the rest of a live code into sibling fields
  // the mark was never put on — readable from `forms` and from a screenshot.
  // Verified in a real browser: typing "483920" in one call put one digit in
  // each of six boxes; through the handle it all stays in the marked one.
  it.each([
    { what: "a password", scenario: "plain" },
    { what: "a password the vault masks", scenario: "masked" },
    { what: "a 64-character credential", scenario: "credential" },
    { what: "the tail of a long value", scenario: "long_value" },
  ])("sends every key of $what through the node the mark is on", ({ scenario }) => {
    const run = probed[scenario];
    expect(run.type_calls).toBe(run.typed_len);
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

  // What the keys carry, through the real Python fill path. One contract, so one
  // table: a line break survives where the node can hold one and is dropped
  // where it cannot, CR and CRLF collapse to a single LF either way, and both
  // that rule and the tab guard apply to the TAIL, which is all that gets typed.
  //
  // Every row types. That is the point — the branch this replaced gave the
  // keystrokes up whenever a break appeared, which is the one property issue #86
  // exists for. `typed_has_cr` pins the ORDER: CR becomes LF before the strip,
  // so a CR never reaches `type()`, which would send it as Enter and submit the
  // form with half a credential in the field.
  it.each([
    {
      what: "a break an input cannot hold is dropped, and the rest still typed",
      scenario: "newline_single_line", typedLen: "onetwo".length,
    },
    {
      what: "the same break spelled as CR, which must not reach the keys",
      scenario: "cr_single_line", typedLen: "onetwo".length,
    },
    {
      what: "a break a textarea holds as a character is kept",
      scenario: "newline_multiline", typedLen: "one\ntwo".length,
    },
    {
      what: "a CRLF becomes one break, not two Enters",
      scenario: "crlf_multiline", typedLen: "one\ntwo".length,
    },
    {
      what: "a break in the assigned head leaves the tail typed as it was",
      scenario: "newline_outside_tail", typedLen: probed.constants.typed_chars,
    },
    {
      what: "a tab in the assigned head leaves the tail typed as it was",
      scenario: "tab_outside_tail", typedLen: probed.constants.typed_chars,
    },
  ])("$what", ({ scenario, typedLen }) => {
    const run = probed[scenario];
    expect(run.trace).toContain("handle.type");
    expect(run.typed_has_cr).toBe(false);
    expect(run.typed_len).toBe(typedLen);
    expect(run.result).toEqual({ ok: true, frame: 0 });
  });

  it("assigns a value carrying a tab, which no key can put in the field", () => {
    // The one character normalization cannot rescue: `type()` sends it as the
    // Tab KEY, which moves focus rather than adding anything, so "a\tb" would
    // land as "ab" — a gap mid-value, which KEYS_DROPPED_JS only recognises as a
    // prefix, so nothing repairs it and the fill reports a value the node never
    // held. An assignment carries a tab, so that is the path it takes.
    const run = probed.tab_value;
    expect(run.trace).not.toContain("handle.type");
    expect(run.typed_len).toBeNull();
    expect(run.result).toEqual({ ok: true, frame: 0 });
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
    // A field that took the keys pays for no fallback — neither the ordinary
    // one nor the one whose head was assigned and tail typed. Which fields
    // count as having taken them, including the reshaping case, is the table
    // over KEYS_DROPPED_JS further down.
    expect(probed.plain.trace.filter((t) => t === "handle.assign")).toHaveLength(1);
    expect(probed.long_value.trace.filter((t) => t === "handle.assign")).toHaveLength(1);
  });

  it("keeps the timed budgets under the cap the device arms", () => {
    // The device drops its pending entry and tells this process nothing, so a
    // fill that ran past that would go on typing a credential into a page whose
    // answer nobody is waiting for. Read the cap from the one place it is
    // declared — a copy in server.py would only be a second thing to drift.
    // The TIMED steps a fill can spend: resolve the node, assign the head, type
    // the tail, and — when the keys were dropped — assign the whole value. Two
    // spends are outside this and neither is bounded: a caller that names no
    // frame pays for the search (#96), and `evaluate` takes no timeout at all.
    const c = probed.constants;
    expect(c.action_timeout_ms * 3 + c.typing_max_ms).toBeLessThan(hostCapMs());
    // And the tail draws on ONE budget, not one per key: handing each key the
    // tail's own would let them stack to TYPED_CHARS times it. A shared
    // deadline is already counting down by the first key, so no key is ever
    // handed the whole of it — which a per-key timeout hands out every time.
    // The fixture spends a millisecond per key, which comes off the shared
    // deadline before the next key's budget is computed — so the gap between
    // the first key's and the last's is one it caused, not one the interpreter
    // happened to leave.
    const run = probed.long_value;
    expect(run.key_timeout_max).toBeLessThan(c.typing_max_ms);
    expect(run.key_timeout_max! - run.key_timeout_min!).toBeGreaterThanOrEqual(
      run.type_calls - 1,
    );
  });

  it("types a 64-character credential whole", () => {
    // TYPED_CHARS decides whether a value ends up typed or assigned, and
    // server.py's comment on it owns why the number is what it is. What this
    // pins is that a credential the size it was chosen for is typed whole; the
    // over-length case is "types the tail of a value too long to type whole".
    expect(probed.constants.typed_chars).toBeGreaterThanOrEqual(64);
    expect(probed.credential.typed_len).toBe(probed.credential.asked_len);
  });

  it("does not try the next frame once a node has been changed", () => {
    // The caller named no frame, so the search walks them — and the fill fails
    // in the first after already changing it. Retrying in the second would
    // leave two fields holding something and report the identity of whichever
    // happened to work.
    const run = probed.two_frames;
    expect(run.first_changed).toBe(true);
    expect(run.error).toBe("RuntimeError");
    expect(run.result).toBeNull();
    expect(run.second_len).toBe(0);
    // One resolution, not one per frame.
    expect(run.trace.filter((t) => t === "frame.wait_for_selector")).toHaveLength(1);
  });

  it("fails loudly when the field will not take the value at all", () => {
    // The end of that path: the keys were dropped and the assignment is
    // refused too. The caller hears about it rather than being told a
    // credential went in — and the field is holding nothing, so the mark that
    // went on for the value comes back off rather than withholding an empty
    // field from the forms scan for the life of the page.
    const run = probed.keys_dropped_unfillable;
    expect(run.trace).toContain("handle.assign-failed");
    expect(run.error).toBe("RuntimeError");
    expect(run.marked).toBe(false);
    expect(run.ledgered).toBe(false);
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

  it("reports the frame that had the field, wherever the one that went away sits", () => {
    // Both answer `wait_for_selector` with a failure, and only one of them was
    // ever going to be able to fill anything. Every frame is tried either way.
    expect(probed.ranked).toEqual({ error: "Hidden", tried: 3 });
    // A frames list is DOM order, so the frame that went away sits above the
    // payment one as often as below it. The answer is the same either way.
    expect(probed.ranked_gone_first).toEqual({ error: "Hidden", tried: 3 });
  });

  it("still hears the frame that went away when nothing else spoke", () => {
    expect(probed.ranked_only_gone).toEqual({ error: "Detached", tried: 2 });
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

/** The action cap the device arms, read from the one place it is declared. */
function hostCapMs(): number {
  const agent = fs.readFileSync(
    fileURLToPath(new URL("../src/deviceAgent.ts", import.meta.url)),
    "utf8",
  );
  const m = /actionTimeoutMs:\s*([\d_]+)/.exec(agent);
  if (!m) throw new Error("actionTimeoutMs not found in deviceAgent.ts");
  return Number(m[1].replace(/_/g, ""));
}

/** A `"""…"""` literal, lifted from the server so the test can't drift. */
function loadScript(name: string): (el: unknown) => unknown {
  const src = fs.readFileSync(SERVER_PY, "utf8");
  const m = new RegExp(`^${name} = (f)?"""([\\s\\S]*?)"""$`, "m").exec(src);
  if (!m) throw new Error(`${name} literal not found in server.py`);
  // Some are f-strings, interpolating a module-level `_NAME = "…"` fragment so
  // that a rule stated once is asked by every question that needs it. Resolving
  // it here is what keeps this asserting the script the browser actually runs —
  // and only for those, because `}}` is ordinary JS in a plain literal and
  // unescaping it there would lift source the server never runs.
  const body = !m[1]
    ? m[2]
    : m[2]
        .replace(/\{(_[A-Z_]+)\}/g, (_whole, fragment: string) => {
          const f = new RegExp(`^${fragment} = "(.*)"$`, "m").exec(src);
          if (!f) throw new Error(`${fragment} fragment not found in server.py`);
          return f[1];
        })
        .replace(/\{\{|\}\}/g, (brace) => brace[0]);
  return new Function(`return (${body})`)() as (el: unknown) => unknown;
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

describe("the cap the fill's budgets are measured against", () => {
  // The sum that has to fit under it needs the server's constants, so that
  // assertion is Python-gated. This is not: it only reads `deviceAgent.ts`, so
  // a rename of `actionTimeoutMs` fails on every host rather than only on one
  // with an interpreter, where the gated sum would be the first to notice.
  it("is a timer the device still arms", () => {
    expect(hostCapMs()).toBeGreaterThan(0);
  });
});

describe("whether the keys landed", () => {
  // `KEYS_DROPPED_JS` decides whether a typed fill has to fall back to
  // assigning the value outright. It is the difference between repairing a
  // field that dropped the keys and trampling one that merely reshaped them,
  // so it is asserted against the literal `server.py` evaluates.
  const dropped = loadScript("KEYS_DROPPED_JS") as unknown as (
    el: { value?: string; textContent?: string },
    wanted: string,
  ) => boolean;

  it.each([
    // The field took none of them — a number input handed something that is
    // not a number sanitises the lot away.
    { what: "an empty field", el: { value: "" }, wanted: "hunter2", fallback: true },
    // It took a prefix and stopped: a maxlength.
    { what: "a truncated field", el: { value: "hunt" }, wanted: "hunter2", fallback: true },
    // It took every key. Nothing to repair.
    { what: "a field holding the value", el: { value: "hunter2" }, wanted: "hunter2", fallback: false },
    // It took every key and reformatted them on the way in. Assigning over
    // that would throw away the keystrokes and land the same transform again.
    {
      what: "a card number the field spaced out",
      el: { value: "4111 1111" },
      wanted: "41111111",
      fallback: false,
    },
    {
      what: "a value the field upper-cased",
      el: { value: "HUNTER2" },
      wanted: "hunter2",
      fallback: false,
    },
    // These two pin `_HELD`'s shared shape rather than a fill outcome: typing
    // only ever reaches an <input> or a <textarea> now, so KEYS_DROPPED_JS is
    // never asked about a contenteditable. `_HELD` is still asked — the
    // snapshot and nothing-landed questions run on the assignment path, where
    // one is reachable — and reading its text as an input's value reads it as
    // empty, which would call every such fill dropped.
    {
      what: "a contenteditable holding the value",
      el: { textContent: "hunter2" },
      wanted: "hunter2",
      fallback: false,
    },
    {
      what: "an empty contenteditable",
      el: { textContent: "" },
      wanted: "hunter2",
      fallback: true,
    },
  ])("$what needs the assignment: $fallback", ({ el, wanted, fallback }) => {
    expect(dropped(el, wanted)).toBe(fallback);
  });
});

describe("whether a fill that failed left anything behind", () => {
  // `NOTHING_LANDED_JS` decides whether a node that raised mid-fill is put back
  // as it was found or kept marked and ledgered. Reading a contenteditable as
  // an input reads it as empty, which calls a half-landed credential harmless
  // and strips the mark off it — so both ways a node can hold text are here.
  const nothingLanded = loadScript("NOTHING_LANDED_JS") as unknown as (
    el: { value?: string; textContent?: string },
    previous: string,
  ) => boolean;
  const snapshot = loadScript("VALUE_SNAPSHOT_JS") as (el: {
    value?: string;
    textContent?: string;
  }) => string;

  it.each([
    { what: "an input", el: { value: "1 Elm" } },
    // The row that goes red if the snapshot is taken through `value`.
    { what: "a contenteditable", el: { textContent: "1 Elm" } },
  ])("captures what $what was holding", ({ el }) => {
    expect(snapshot(el)).toBe("1 Elm");
  });

  it.each([
    { what: "an input still holding what it held", el: { value: "1 Elm" }, before: "1 Elm", nothing: true },
    { what: "an emptied input", el: { value: "" }, before: "1 Elm", nothing: true },
    // Something landed in it that nobody can account for.
    { what: "an input holding more than it did", el: { value: "1 Elm Sec" }, before: "1 Elm", nothing: false },
    {
      what: "a contenteditable still holding what it held",
      el: { textContent: "1 Elm" },
      before: "1 Elm",
      nothing: true,
    },
    { what: "an emptied contenteditable", el: { textContent: "" }, before: "1 Elm", nothing: true },
    // The row that goes red if the question is asked through `value`.
    {
      what: "a contenteditable holding more than it did",
      el: { textContent: "1 Elm Sec" },
      before: "1 Elm",
      nothing: false,
    },
  ])("$what: nothing landed is $nothing", ({ el, before, nothing }) => {
    expect(nothingLanded(el, before)).toBe(nothing);
  });
});

describe("which nodes take typing", () => {
  // The predicate itself, run as the page runs it — no python, no browser. What
  // it decides is which nodes get keystrokes and which are assigned, and the
  // whole hazard is on the empty side: `type()` refuses nothing, so "yes" typed
  // at a checkbox toggles nothing and answers ok, a <select> changes option by
  // type-ahead, a date input takes the segments in locale order, a hidden input
  // cannot even hold focus — so the keystrokes, on the credential path a
  // secret's characters, land wherever focus already was.
  //
  // It answers a KIND rather than a boolean because one more question rides on
  // the same call: whether the node holds a line break. A textarea holds one as
  // a character; an <input>'s value sanitization strips it.
  const typeable = loadScript("TYPEABLE_JS") as (el: unknown) => string;
  // Each stub carries what the predicate READS of that shape, and nothing more:
  // a property no branch reaches reads as coverage while pinning nothing. For an
  // input and a textarea that is `disabled`/`readOnly` — both really have them,
  // and it is the only thing standing between a read-only field and a credential
  // typed at it. For an input it is also `type`, an enumerated reflection:
  // always lowercase, and "text" for an attribute that is missing or
  // unrecognised, which is why `getAttribute` is here to disagree with it.
  const input = (type: string, extra: Record<string, unknown> = {}) => ({
    tagName: "INPUT", type, disabled: false, readOnly: false,
    getAttribute: (k: string) => (k === "type" ? type : null), ...extra,
  });
  // `type` is not the input's alone — a textarea answers "textarea" — so a
  // predicate that dropped the tag check and asked `el.type` by itself would
  // send every textarea back to assignment, and a stub answering undefined
  // would not notice.
  const textarea = (extra: Record<string, unknown> = {}) => ({
    tagName: "TEXTAREA", type: "textarea", disabled: false, readOnly: false,
    getAttribute: () => null, ...extra,
  });
  // Anything else, whatever it declares about itself.
  const element = (tagName: string, extra: Record<string, unknown> = {}) => ({
    tagName, getAttribute: () => null, ...extra,
  });

  it.each([
    // Every type on the list, because dropping one silently sends that field
    // back to assignment — the tell issue #86 is about — with nothing red.
    { what: "a text field", el: input("text"), kind: "single-line" },
    { what: "an email field", el: input("email"), kind: "single-line" },
    { what: "a password field", el: input("password"), kind: "single-line" },
    { what: "a search box", el: input("search"), kind: "single-line" },
    { what: "a phone field, which is where a one-time code lands", el: input("tel"), kind: "single-line" },
    { what: "a url field", el: input("url"), kind: "single-line" },
    { what: "a number field, which is the card expiry beside a credential", el: input("number"), kind: "single-line" },
    // The commonest input in the wild carries no type attribute at all: the
    // property answers "text" where `getAttribute` answers null, so a predicate
    // rewritten to read the attribute — as every other literal in this file does
    // — would send every one of them back to assignment.
    { what: "an input with no type attribute", el: input("text", { getAttribute: () => null }), kind: "single-line" },
    // The attribute is case-insensitive and the property is not: ordinary
    // markup where the two disagree on more than presence.
    { what: "an input whose type attribute is capitalised", el: input("password", { getAttribute: (k: string) => (k === "type" ? "Password" : null) }), kind: "single-line" },
    // The node that holds a line break as a character, which is the only reason
    // this predicate answers a kind rather than a boolean.
    { what: "a textarea", el: textarea(), kind: "multiline" },
    { what: "a checkbox", el: input("checkbox"), kind: "" },
    { what: "a radio button", el: input("radio"), kind: "" },
    { what: "a file picker", el: input("file"), kind: "" },
    { what: "a submit button", el: input("submit"), kind: "" },
    { what: "a hidden input, which cannot take focus", el: input("hidden"), kind: "" },
    { what: "a date input Firefox lays out as segments", el: input("date"), kind: "" },
    { what: "a range slider", el: input("range"), kind: "" },
    { what: "a read-only input", el: input("password", { readOnly: true }), kind: "" },
    { what: "a disabled input", el: input("password", { disabled: true }), kind: "" },
    { what: "a read-only textarea", el: textarea({ readOnly: true }), kind: "" },
    { what: "a disabled textarea", el: textarea({ disabled: true }), kind: "" },
    // Everything else is assigned, whatever it says about itself. Typing is not
    // extended to arbitrary editing hosts: the credential submits this exists
    // for are <input>, and admitting them cost a second editability taxonomy —
    // which declared values count, which embedded and non-rendered tags to
    // refuse before reading the attribute — for a case no machine here reaches.
    { what: "a select", el: element("SELECT", { value: "" }), kind: "" },
    { what: "an iframe", el: element("IFRAME"), kind: "" },
    { what: "a span", el: element("SPAN"), kind: "" },
    {
      what: "a contenteditable div, which is assigned as it was before typing",
      el: element("DIV", { getAttribute: (k: string) => (k === "contenteditable" ? "true" : null) }),
      kind: "",
    },
    {
      what: "the body of a document in designMode",
      el: element("BODY", { ownerDocument: { designMode: "on" } }),
      kind: "",
    },
  ])("$what: kind=$kind", ({ el, kind }) => {
    expect(typeable(el)).toBe(kind);
  });
});

// The allowlist is the difference between refusing a value a field genuinely
// cannot hold and refusing one that lands intact, so it is asserted against the
// script the browser actually runs rather than through a stub that answers for
// it. `maxLength` REFLECTS the attribute everywhere; only some kinds enforce it.
describe("which fields report a cap", () => {
  const cap = loadScript("FIELD_CAP_JS") as (el: unknown) => number;
  // `type` is an enumerated reflection: always a lowercase string on the
  // elements that have one — "text" for a missing or unrecognised attribute,
  // "textarea" on a textarea, "select-one" on a select — so a row gives what
  // the IDL gives, and an element with no `type` at all reads `undefined`.
  const node = (
    tagName: string, type: string | undefined, maxLength: number,
    extra: Record<string, unknown> = {},
  ) => ({
    tagName, type, maxLength,
    // Every stub answers attributes, so a rewrite reading the ATTRIBUTE rather
    // than the IDL property fails on the assertion for the whole table instead
    // of throwing on the eleven rows that never carried the method.
    // Keyed on the tag as well as the name: of the tags stubbed here, only the
    // input has a `type` content attribute, so a textarea or a select answers
    // null the way a real one does.
    // Otherwise an attribute-reading rewrite would read "textarea" off the stub
    // and keep reporting a cap where the real DOM hands it null.
    getAttribute: (k: string) => (k === "type" && tagName === "INPUT" ? type ?? null : null),
    ...extra,
  });

  it.each([
    // Every kind on the allowlist, because dropping one silently sends that
    // field back to being filled and clipped instead of refused.
    { what: "a text input", el: node("INPUT", "text", 16), reports: 16 },
    { what: "a search input", el: node("INPUT", "search", 12), reports: 12 },
    { what: "a url input", el: node("INPUT", "url", 20), reports: 20 },
    { what: "a tel input", el: node("INPUT", "tel", 10), reports: 10 },
    { what: "an email input", el: node("INPUT", "email", 8), reports: 8 },
    { what: "a password input", el: node("INPUT", "password", 16), reports: 16 },
    // The script compares `el.type` raw, which only holds because the property
    // is the canonical keyword however the attribute was written. Pinned here
    // the way the typeable table pins it, so a rewrite that read the ATTRIBUTE
    // instead fails on the assertion rather than on the stub.
    {
      what: "an input whose type attribute is capitalised",
      el: node("INPUT", "password", 16, {
        getAttribute: (k: string) => (k === "type" ? "Password" : null),
      }),
      reports: 16,
    },
    { what: "a textarea", el: node("TEXTAREA", "textarea", 40), reports: 40 },
    // Everything below carries the attribute and is not governed by it. Reading
    // one here would turn an authoring mistake into a fill that never lands.
    { what: "a number input carrying a stray maxlength", el: node("INPUT", "number", 4), reports: -1 },
    { what: "a date input carrying one", el: node("INPUT", "date", 4), reports: -1 },
    { what: "a checkbox carrying one", el: node("INPUT", "checkbox", 4), reports: -1 },
    { what: "a contenteditable host", el: node("DIV", undefined, 4), reports: -1 },
    { what: "a select", el: node("SELECT", "select-one", 4), reports: -1 },
    // -1 is what an uncapped field reports, and what the parser coerces an
    // invalid attribute value to. 0 is a real cap that holds nothing, so it
    // must pass through as itself — a `|| -1` tidy would read it as uncapped.
    { what: "an uncapped text input", el: node("INPUT", "text", -1), reports: -1 },
    { what: "a field capped at zero", el: node("INPUT", "text", 0), reports: 0 },
  ])("reports $what as $reports", ({ el, reports }) => {
    expect(cap(el)).toBe(reports);
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
