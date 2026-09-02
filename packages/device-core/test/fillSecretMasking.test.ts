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
import {
  BrowserHostConfig,
  BrowserSessions,
  CredentialBroker,
  PaymentApprovalClient,
  PaymentApprovalRequest,
} from "@domo/device-core";
import { DEFAULT_ACTION_TIMEOUT_MS, TYPING_MAX_MS } from "@domo/browser-server";

const FAKE_SERVER = fileURLToPath(
  new URL("../../../e2e/fixtures/fakeBrowserServer.cjs", import.meta.url),
);
const FAKE_BROKER = fileURLToPath(
  new URL("../../../e2e/fixtures/fakeVaultBroker.cjs", import.meta.url),
);

interface Ctx {
  sessions: BrowserSessions;
  browsers: BrowserHostConfig;
  events: { event: string; fields: { [k: string]: JSONValue } }[];
  /** What the injected approval client was asked — empty when none is wired. */
  approvalCalls: PaymentApprovalRequest[];
  dir: string;
  cmdLog: string;
  brokerLog: string;
  fillLog: string;
}

let ctx: Ctx;

/** A payment-approval client that records what it was asked and answers as told;
 * `"throw"` stands in for an unreachable service / non-2xx / timeout — all of
 * which the gate must treat as NOT approved. */
function fakeApproval(
  answer: { approved: boolean } | "throw",
  record: PaymentApprovalRequest[],
): PaymentApprovalClient {
  return {
    async consumePaymentApproval(request: PaymentApprovalRequest) {
      record.push(request);
      if (answer === "throw") throw new Error("approval service unreachable");
      return answer;
    },
  };
}

function makeCtx(
  serverEnv: Record<string, string> = {},
  brokerEnv: Record<string, string> = {},
  /** The financial-gate approval client: `null` (the default) wires none, which
   * fails closed on a bank destination. */
  approval: { approved: boolean } | "throw" | null = null,
): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-mask-"));
  const cmdLog = path.join(dir, "cmds.log");
  const brokerLog = path.join(dir, "broker-audit.log");
  const fillLog = path.join(dir, "fills.log");
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
          { label: "totp", hidden: true, custom: false, alias: false },
          { label: "shipping address", hidden: false, custom: true, alias: false },
          { label: "date of birth", hidden: false, custom: true, alias: false },
        ],
        values: {
          username: "jon",
          password: "hunter2",
          totp: "483920",
          "shipping address": "1 Elm St",
          "date of birth": "unknown",
        },
      },
      {
        // A bank login, for the financial-gate cases below. chase.com is on the
        // bundled bank-domain list, so a fill onto it is gated.
        id: "B1",
        title: "Chase",
        category: "LOGIN",
        username: "jon",
        urls: ["https://chase.com/login"],
        descriptors: [
          { label: "username", hidden: false, custom: false, alias: false },
          { label: "password", hidden: true, custom: false, alias: false },
        ],
        values: { username: "jon", password: "hunter2" },
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
          { label: "expiry month", hidden: false, custom: false, alias: false },
          { label: "expiry year", hidden: false, custom: false, alias: false },
          { label: "expiry", hidden: false, custom: false, alias: false },
        ],
        values: {
          number: "4111111111111111", code: "737", "cardholder name": "Jon Doe",
          "expiry month": "04", "expiry year": "2031", expiry: "2031-04",
        },
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
          { label: "date of birth", hidden: false, custom: false, alias: false },
        ],
        values: {
          ssn: "078-05-1120",
          "passport number": "X1234567",
          "license number": "D9999",
          address1: "1 Elm St",
          city: "Springfield",
          "date of birth": "1984-11-09",
        },
      },
    ]),
  );
  const events: Ctx["events"] = [];
  const approvalCalls: PaymentApprovalRequest[] = [];
  const browsers = {
    command: [process.execPath, FAKE_SERVER],
    headed: false,
    env: { FAKE_CMD_LOG: cmdLog, FAKE_FILL_LOG: fillLog, ...serverEnv },
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
    undefined,
    approval === null ? null : fakeApproval(approval, approvalCalls),
  );
  return { sessions, browsers, events, approvalCalls, dir, cmdLog, brokerLog, fillLog };
}

/** What the audit calls this session — read off the open event, not recomputed. */
const audited = (): string =>
  ctx.events.find((e) => e.event === "browser_session_opened")!.fields.session as string;

/** Open a session already approved for both items and both origins. */
async function session(): Promise<string> {
  const opened = await ctx.sessions.open("i1", "agent-1", ["pizza.example", "payframe.example"]);
  const handle = (opened as { session: string }).session;
  ctx.sessions.extend("i2", handle, [], ["L1", "C1", "I1"]);
  await ctx.sessions.command(handle, {
    action: "goto",
    url: "https://pizza.example/login",
  });
  return handle;
}

/** Open a session approved for the bank item + origin, landed on the bank page. */
async function bankSession(): Promise<string> {
  // Plow's RelayAuth.agent_id is the decimal string form of its database
  // Session.id. Keep this fixture wire-realistic: a local label such as
  // "agent-1" would not be accepted by the backend's integer field.
  const opened = await ctx.sessions.open("i1", "42", ["chase.com"], false);
  const handle = (opened as { session: string }).session;
  ctx.sessions.extend("i2", handle, [], ["B1"], false);
  await ctx.sessions.command(handle, { action: "goto", url: "https://chase.com/login" });
  return handle;
}

/** The broker's own audit lines that mean it was asked for, and handed over, a
 * value — proof the vault WAS (or was not) reached. */
const released = (): string[] =>
  fs.existsSync(ctx.brokerLog)
    ? fs.readFileSync(ctx.brokerLog, "utf8").trim().split("\n").filter((l) => l.includes("RELEASED"))
    : [];

/** Every command the device sent, values already redacted by the fixture. */
function commands(): {
  action: string; selector?: string; mask?: boolean; frame_token?: string; value?: string;
}[] {
  return fs
    .readFileSync(ctx.cmdLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as {
      action: string; selector?: string; mask?: boolean; frame_token?: string; value?: string;
    });
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
    const opened = await sessions.open("i1", "agent-1", ["pizza.example"]);
    const h = (opened as { session: string }).session;
    sessions.extend("i2", h, [], ["L1"]);
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

  // The browser reports that the field is holding something else; it does not
  // judge whether that matters. Here it can be judged: the value came out of
  // the vault, so a field that changed it did not receive the credential.
  it.each([
    { what: "the field says it holds less than the value",
      env: { FAKE_TOO_LONG: "16" },
      says: ["holds only 16 characters", "shortened where it is stored"],
      omits: ["check the selector"],
      reason: "the field holds only 16 characters" },
    { what: "the field is holding something other than what was typed",
      env: { FAKE_ALTERED: "1" },
      // It DID go in — a changed copy is in the field, and saying "not filled"
      // would leave the caller thinking the page was untouched.
      says: ["holding a changed copy", "still in the field", "not at fault"],
      // The other one's remedy: it would send the owner to change a credential
      // that is not the problem.
      omits: ["shortened"],
      reason: "the field is holding a changed copy of the value" },
  ])("refuses a credential fill when $what", async ({ env, says, omits, reason }) => {
    await ctx.sessions.closeAll("teardown");
    ctx = makeCtx(env);
    const handle = await session();
    const before = ctx.events.length;
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selector: "#card-number", item: "C1", field: "number",
    });
    expect(jv(result).get("status").str).toBe("error");
    const error = jv(result).get("error").str ?? "";
    for (const text of says) expect(error).toContain(text);
    for (const text of omits) expect(error).not.toContain(text);
    expect(ctx.events.slice(before).at(-1)).toEqual({
      event: "credential_fill_failed",
      fields: {
        session: audited(), item: "C1", field: "number",
        origin: "payframe.example", selector: "#card-number", reason,
      },
    });
    expect(JSON.stringify(result)).not.toContain("4111");
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
    const reopened = await ctx.sessions.open("i9", "agent-2", ["other.example"]);
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

describe("fill_secret formats a date of birth", () => {
  const typed = (): string[] =>
    fs.existsSync(ctx.fillLog) ? fs.readFileSync(ctx.fillLog, "utf8").trim().split("\n") : [];

  it.each([
    { format: undefined, want: "1984-11-09" },
    { format: "MM/DD/YYYY", want: "11/09/1984" },
    { format: "MMMM", want: "November" },
    { format: "YYYY", want: "1984" },
  ])("types it as $format", async ({ format, want }) => {
    const handle = await session();
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selector: "#dob", item: "I1", field: "date of birth",
      ...(format === undefined ? {} : { format }),
    });
    expect(result).toEqual({ status: "completed", ok: true, frame: 0 });
    expect(typed()).toEqual([`#dob\t${want}\t0`]);
  });

  it("refuses a format for a field that is not a date, before asking the vault", async () => {
    const handle = await session();
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selector: "#city", item: "I1", field: "city", format: "MM",
    });
    expect(result).toMatchObject({ status: "error", error: expect.stringMatching(/format applies only to a date field/) });
    expect(released()).toEqual([]);
    expect(typed()).toEqual([]);
  });

  it("refuses a pattern with a letter that is not a token, before asking the vault", async () => {
    const handle = await session();
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selector: "#dob", item: "I1", field: "date of birth", format: "MM/DD/YYYY hh",
    });
    expect(result).toMatchObject({ status: "error", error: expect.stringMatching(/'h' is not a date token/) });
    expect(released()).toEqual([]);
    expect(typed()).toEqual([]);
  });

  it("refuses a format after the vault answers with a value that is not a date", async () => {
    // L1's "date of birth" is a CUSTOM field — the label a fixed slot owns on
    // an identity, but here just a name a person gave a login field — so its
    // value never passed the write-path ISO validation an identity's own
    // birthDate does.
    const handle = await session();
    const before = ctx.events.length;
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selector: "#dob", item: "L1", field: "date of birth", format: "MM",
    });
    expect(result).toMatchObject({ status: "error", error: expect.stringMatching(/not a date/) });
    expect(typed()).toEqual([]);
    expect(commands().some((c) => c.action === "fill")).toBe(false);
    expect(ctx.events.slice(before).at(-1)).toEqual({
      event: "credential_fill_failed",
      fields: {
        session: audited(), item: "L1", field: "date of birth", origin: "pizza.example",
        selector: "#dob",
        reason: "the stored value is not a date",
      },
    });
  });

  it("types the same custom field as stored when no format is given at all", async () => {
    // Same L1 custom field, no format this time: an empty shape means "as
    // stored", so a non-date value fills fine — only a given format asks it
    // to be reshaped into something it isn't.
    const handle = await session();
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selector: "#dob", item: "L1", field: "date of birth",
    });
    expect(result).toEqual({ status: "completed", ok: true, frame: 0 });
    expect(typed()).toEqual(["#dob\tunknown\t0"]);
  });
});

describe("fill_secret formats a card's expiry", () => {
  const typed = (): string[] =>
    fs.existsSync(ctx.fillLog) ? fs.readFileSync(ctx.fillLog, "utf8").trim().split("\n") : [];
  it.each([
    { format: undefined, want: "04/31" },
    { format: "MM/YYYY", want: "04/2031" },
    { format: "MMMM", want: "April" },
    { format: "YYYY", want: "2031" },
  ])("types it as $format", async ({ format, want }) => {
    const handle = await session();
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selector: "#exp", item: "C1", field: "expiry",
      ...(format === undefined ? {} : { format }),
    });
    expect(result).toEqual({ status: "completed", ok: true, frame: 0 });
    expect(typed()).toEqual([`#exp\t${want}\t0`]);
  });
  it("refuses a day token for a month-only date before asking the vault", async () => {
    const handle = await session();
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selector: "#exp", item: "C1", field: "expiry", format: "MM/DD/YY",
    });
    expect(result).toMatchObject({ status: "error", error: expect.stringMatching(/no day/) });
    expect(released()).toEqual([]);
    expect(typed()).toEqual([]);
  });
});

describe("fill_secret split across single-character boxes", () => {
  // A segmented one-time-code control: six boxes, one character each. The agent
  // never has the value, so the split happens on the device — one vault
  // release, one approved document, one masked character per box.
  const BOXES = ["#c1", "#c2", "#c3", "#c4", "#c5", "#c6"];

  /** Every fill the fixture saw, with the redacted value length it logged. */
  const sentFills = () => commands().filter((c) => c.action === "fill");

  it("splits a code across its boxes: one release, one masked character each", async () => {
    const handle = await session();
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selectors: BOXES, item: "L1", field: "totp",
    });
    expect(result).toEqual({ status: "completed", ok: true, frame: 0 });
    // Six one-character fills, each masked, each pinned to the one approved
    // document, in the order the code is read.
    expect(fills()).toEqual(BOXES.map((selector) => ({ selector, mask: true })));
    for (const c of sentFills()) {
      expect(c.value).toBe("<1 chars>");
      expect(c.frame_token).toBe("doc-top");
    }
    // Every box was located before the vault was asked, and the vault was
    // asked exactly once — six releases would be six chances for a rotating
    // code to change mid-fill.
    expect(commands().filter((c) => c.action === "locate").map((c) => c.selector)).toEqual(BOXES);
    expect(released().length).toBe(1);
    expect(ctx.events.at(-1)).toEqual({
      event: "credential_filled",
      fields: { session: audited(), item: "L1", field: "totp", origin: "pizza.example", boxes: 6 },
    });
    expect(JSON.stringify(ctx.events)).not.toContain("483920");
  });

  it("splits a formatted date of birth across its boxes, one digit each", async () => {
    const DOB_BOXES = ["#d1", "#d2", "#d3", "#d4", "#d5", "#d6", "#d7", "#d8"];
    const handle = await session();
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selectors: DOB_BOXES, item: "I1", field: "date of birth", format: "MMDDYYYY",
    });
    expect(result).toEqual({ status: "completed", ok: true, frame: 0 });
    // A date of birth is not masked, so no box carries the mark, and the cmd
    // log redacts fill values — read the fixture's own unredacted fill log for
    // the character each box actually received.
    expect(fills()).toEqual(DOB_BOXES.map((selector) => ({ selector })));
    expect(
      fs.readFileSync(ctx.fillLog, "utf8").trim().split("\n").map((l) => l.split("\t")[1]),
    ).toEqual(["1", "1", "0", "9", "1", "9", "8", "4"]);
  });

  it("refuses a box count the value does not fill, and types nothing", async () => {
    const handle = await session();
    const before = ctx.events.length;
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selectors: BOXES.slice(0, 5), item: "L1", field: "totp",
    });
    expect(jv(result).get("status").str).toBe("error");
    expect(jv(result).get("error").str).toContain("does not split into 5 one-character boxes");
    expect(fills()).toEqual([]);
    expect(ctx.events.slice(before).at(-1)).toEqual({
      event: "credential_fill_failed",
      fields: {
        session: audited(), item: "L1", field: "totp", origin: "pizza.example",
        selector: BOXES.slice(0, 5).join(" "),
        reason: "the value does not have one character per box",
      },
    });
    expect(JSON.stringify(result)).not.toContain("483920");
  });

  it.each([
    { what: "one box only", params: { selectors: ["#c1"] }, says: "at least two" },
    { what: "a non-string entry", params: { selectors: ["#c1", 2] }, says: "at least two" },
    { what: "a duplicate box", params: { selectors: ["#c1", "#c1"] }, says: "the same box twice" },
    {
      what: "both selector and selectors",
      params: { selector: "#pass", selectors: ["#c1", "#c2"] },
      says: "never both",
    },
    {
      what: "more boxes than any code has",
      params: { selectors: Array.from({ length: 17 }, (_, i) => `#x${i}`) },
      says: "at most 16",
    },
  ])("refuses $what before anything is located or released", async ({ params, says }) => {
    const handle = await session();
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", item: "L1", field: "totp", ...params,
    });
    expect(jv(result).get("status").str).toBe("error");
    expect(jv(result).get("error").str).toContain(says);
    expect(commands().some((c) => c.action === "locate" || c.action === "fill")).toBe(false);
    expect(released()).toEqual([]);
  });

  it("refuses boxes scattered across documents, before the vault is asked", async () => {
    // The fixture puts "#card*" selectors in the payment iframe and everything
    // else in the top document — so this pair straddles two documents.
    const handle = await session();
    const before = ctx.events.length;
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selectors: ["#c1", "#card-2"], item: "L1", field: "totp",
    });
    expect(jv(result).get("status").str).toBe("error");
    expect(jv(result).get("error").str).toContain("#card-2 is in a different document than #c1");
    expect(fills()).toEqual([]);
    expect(released()).toEqual([]);
    expect(ctx.events.slice(before).at(-1)).toEqual({
      event: "credential_denied",
      fields: {
        session: audited(), item: "L1", field: "totp", origin: "payframe.example",
        reason: "the boxes are not all in one document",
      },
    });
  });

  it("clears the boxes it touched, under their mask, and owns up to one that would not empty", async () => {
    await ctx.sessions.closeAll("teardown");
    ctx = makeCtx({ FAKE_ALTERED_SELECTOR: "#c3" });
    const handle = await session();
    const before = ctx.events.length;
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret", selectors: BOXES, item: "L1", field: "totp",
    });
    expect(jv(result).get("status").str).toBe("error");
    expect(jv(result).get("error").str).toContain("#c3 rewrote the character");
    // #c3 undoes the empty write too (the fixture alters every fill of it), the
    // way a controlled input restores its value — so the result names it as
    // not emptied instead of claiming every box was cleared.
    expect(jv(result).get("error").str).toContain("cleared, except #c3");
    expect(jv(result).get("error").str).toContain("stays masked");
    // Three characters went in (#c3's came back changed); then every touched
    // box was erased UNDER ITS MASK. An unmasked clear would take the mark off
    // and drop the field from the browser's ledger before it learns what the
    // node kept — a controlled input that undoes the empty write would then
    // show its character to every later screenshot. Boxes four through six
    // were never written at all.
    expect(sentFills().map((c) => ({ selector: c.selector, value: c.value, masked: c.mask === true }))).toEqual([
      { selector: "#c1", value: "<1 chars>", masked: true },
      { selector: "#c2", value: "<1 chars>", masked: true },
      { selector: "#c3", value: "<1 chars>", masked: true },
      { selector: "#c1", value: "<0 chars>", masked: true },
      { selector: "#c2", value: "<0 chars>", masked: true },
      { selector: "#c3", value: "<0 chars>", masked: true },
    ]);
    // The owner's log hears both: the fill that failed, and the box the
    // rollback could not empty.
    expect(ctx.events.slice(before)).toEqual([
      {
        event: "credential_fill_failed",
        fields: {
          session: audited(), item: "L1", field: "totp", origin: "pizza.example",
          selector: "#c3", reason: "the field is holding a changed copy of the value",
        },
      },
      {
        event: "credential_fill_failed",
        fields: {
          session: audited(), item: "L1", field: "totp", origin: "pizza.example",
          selector: "#c3", reason: "the page kept a character after the fill was rolled back",
        },
      },
    ]);
    expect(JSON.stringify(ctx.events)).not.toContain("483920");
  });
});

describe("fill_secret banking-credential gate", () => {
  // Not-approved and an unreachable/erroring approval service must both block a
  // bank credential release; the audit reason records WHICH, so an outage reads
  // differently from a real "no". "Blocked" is proven by the two things the
  // owner cares about: the vault was never asked (no RELEASED line) and nothing
  // was typed (no fill reached the browser). The agent-facing message stays
  // uniform across every block reason so it cannot probe an outage from a "no".
  it.each([
    {
      what: "the owner has not approved",
      approval: { approved: false } as const,
      reason: "the owner has not approved this payment",
    },
    {
      what: "the approval service is unreachable (a throw stands in for non-2xx / timeout)",
      approval: "throw" as const,
      reason: "the owner-approval service could not be reached",
    },
    {
      what: "no approval client is wired (fail-closed default)",
      approval: null,
      reason: "no owner-approval client is configured",
    },
  ])("refuses a bank credential when $what", async ({ approval, reason }) => {
    await ctx.sessions.closeAll("teardown");
    ctx = makeCtx({}, {}, approval);
    const handle = await bankSession();
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret",
      selector: "#pass",
      item: "B1",
      field: "password",
    });
    expect(jv(result).get("status").str).toBe("error");
    expect(jv(result).get("error").str).toContain("requires the owner's payment approval");
    // The vault was never asked for the value, and nothing was typed.
    expect(released()).toEqual([]);
    expect(fills()).toEqual([]);
    // Recorded as a denial, tagged with the outcome, and no secret leaked.
    expect(ctx.events.at(-1)?.event).toBe("credential_denied");
    expect(ctx.events.at(-1)?.fields.reason).toBe(`banking credential release blocked: ${reason}`);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(ctx.events)).not.toContain("hunter2");
  });

  it("releases a bank credential once approved, binding the consume to this session + domain", async () => {
    await ctx.sessions.closeAll("teardown");
    ctx = makeCtx({}, {}, { approved: true });
    const handle = await bankSession();
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret",
      selector: "#pass",
      item: "B1",
      field: "password",
    });
    expect(result).toEqual({ status: "completed", ok: true, frame: 0 });
    // The single-use approval was consumed for THIS session + destination.
    expect(ctx.approvalCalls).toHaveLength(1);
    expect(ctx.approvalCalls[0]).toEqual({ sessionId: "42", domain: "chase.com" });
    expect(ctx.approvalCalls[0]?.sessionId).not.toBe(audited());
    // … and only then was the vault asked and the field filled, on the bank page.
    expect(released().length).toBe(1);
    expect(fills()).toEqual([{ selector: "#pass", mask: true }]);
    expect(ctx.events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["credential_payment_approved", "credential_filled"]),
    );
  });

  it("never consults the gate for a non-financial destination", async () => {
    // A plain login on a plain site behaves exactly as before: the approval
    // client is never asked — even one that would refuse — and the release
    // proceeds.
    await ctx.sessions.closeAll("teardown");
    ctx = makeCtx({}, {}, { approved: false });
    const handle = await session();
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret",
      selector: "#pass",
      item: "L1",
      field: "password",
    });
    expect(result).toEqual({ status: "completed", ok: true, frame: 0 });
    expect(ctx.approvalCalls).toEqual([]);
    expect(released().length).toBe(1);
    expect(fills()).toEqual([{ selector: "#pass", mask: true }]);
  });

  it("refuses an unreadable bank destination before the approval client is consulted", async () => {
    // Defense-in-depth ordering: the frame-origin check rejects a host it cannot
    // read BEFORE `isFinancialDestination` classifies it, so a garbage
    // destination on what would be a bank fill never reaches the approval
    // consume. `#card*` selectors take the fixture's frame_url; a malformed one
    // has no host. An approval that WOULD have released proves the short-circuit.
    await ctx.sessions.closeAll("teardown");
    ctx = makeCtx({ FAKE_CARD_FRAME_URL: "not-a-url" }, {}, { approved: true });
    const handle = await bankSession();
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret",
      selector: "#card-x",
      item: "B1",
      field: "password",
    });
    expect(jv(result).get("status").str).toBe("error");
    expect(released()).toEqual([]);
    expect(fills()).toEqual([]);
    expect(ctx.approvalCalls).toEqual([]);
    expect(JSON.stringify(ctx.events)).not.toContain("hunter2");
  });
});
// The server's typing budget must fit under the per-action cap the device arms
// — a cross-package invariant, so it reads the device cap from deviceAgent.ts
// and the typing constants from @domo/browser-server rather than restating
// either. The fill BRANCH itself is proven in @domo/browser-server's tests.
describe("the cap the fill's budgets are measured against", () => {
  it("keeps the server's timed budgets under the cap the device arms", () => {
    const cap = hostCapMs();
    expect(cap).toBeGreaterThan(0);
    expect(DEFAULT_ACTION_TIMEOUT_MS * 3 + TYPING_MAX_MS).toBeLessThan(cap);
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

