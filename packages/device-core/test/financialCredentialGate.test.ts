/**
 * The fail-closed banking-credential gate: `fill_secret` refuses to release a
 * credential into a bank destination unless an owner-approved payment approval
 * exists.
 *
 * Two layers:
 *   - the pure DETECTION function (`assessFinancialRelease`) and the fail-closed
 *     default client (`NO_APPROVAL_ENDPOINT`), tested directly at the bottom;
 *   - the ENFORCEMENT in `fillSecret`, driven end to end through the same fake
 *     browser + fake vault broker the masking suite uses — no Python, no
 *     browser. "Blocked" is proven by the two things the owner cares about: the
 *     vault was never asked for the value (no RELEASED line in its audit log)
 *     and nothing was typed into the page (no fill reached the browser).
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
  NO_APPROVAL_ENDPOINT,
  PaymentApprovalClient,
  PaymentApprovalRequest,
  assessFinancialRelease,
} from "@domo/device-core";

const FAKE_SERVER = fileURLToPath(
  new URL("../../../e2e/fixtures/fakeBrowserServer.cjs", import.meta.url),
);
const FAKE_BROKER = fileURLToPath(
  new URL("../../../e2e/fixtures/fakeVaultBroker.cjs", import.meta.url),
);

const BANK_URL = "https://chase.com/login"; // chase.com is in the bundled list
const PLAIN_URL = "https://pizza.example/login"; // not a bank

interface Ctx {
  sessions: BrowserSessions;
  browsers: BrowserHostConfig;
  events: { event: string; fields: { [k: string]: JSONValue } }[];
  approvalCalls: PaymentApprovalRequest[];
  dir: string;
  cmdLog: string;
  brokerLog: string;
}

let ctx: Ctx;

/** An approval client that records what it was asked and answers as told.
 * `answer` is what a real client would return; a thrown value stands in for an
 * error / timeout / absent endpoint. */
function fakeApproval(
  answer: { approved: boolean } | "throw",
  record: PaymentApprovalRequest[],
): PaymentApprovalClient {
  return {
    async checkPaymentApproval(request: PaymentApprovalRequest) {
      record.push(request);
      if (answer === "throw") throw new Error("approval service unreachable");
      return answer;
    },
  };
}

function makeCtx(
  approval: { approved: boolean } | "throw" | "default" = "default",
  serverEnv: Record<string, string> = {},
): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-fingate-"));
  const cmdLog = path.join(dir, "cmds.log");
  const brokerLog = path.join(dir, "broker-audit.log");
  const vaultPath = path.join(dir, "vault.json");
  fs.writeFileSync(
    vaultPath,
    JSON.stringify([
      {
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
        id: "L1",
        title: "Pizza Login",
        category: "LOGIN",
        username: "jon",
        urls: ["https://pizza.example/login"],
        descriptors: [
          { label: "username", hidden: false, custom: false, alias: false },
          { label: "password", hidden: true, custom: false, alias: false },
        ],
        values: { username: "jon", password: "hunter2" },
      },
    ]),
  );
  const events: Ctx["events"] = [];
  const approvalCalls: PaymentApprovalRequest[] = [];
  const browsers = {
    command: [process.execPath, FAKE_SERVER],
    headed: false,
    screenshotsDir: path.join(dir, "shots"),
    env: { FAKE_CMD_LOG: cmdLog, ...serverEnv },
    audit: () => {},
  };
  const credentials = new CredentialBroker({
    command: [process.execPath, FAKE_BROKER],
    env: { FAKE_BROKER_VAULT: vaultPath },
    auditPath: brokerLog,
  });
  const client =
    approval === "default" ? NO_APPROVAL_ENDPOINT : fakeApproval(approval, approvalCalls);
  const sessions = new BrowserSessions(
    browsers,
    credentials,
    (event, fields) => events.push({ event, fields }),
    undefined,
    client,
  );
  return { sessions, browsers, events, approvalCalls, dir, cmdLog, brokerLog };
}

/** Open a session approved for both bank and non-bank origins + both items, and
 * land on `url`. */
async function sessionAt(url: string): Promise<string> {
  const opened = await ctx.sessions.open("i1", "agent-1", ["chase.com", "pizza.example"], false);
  const handle = (opened as { session: string }).session;
  ctx.sessions.extend("i2", handle, [], ["B1", "L1"], false);
  await ctx.sessions.command(handle, { action: "goto", url });
  return handle;
}

/** The fills the device actually sent to the browser — proof of whether a
 * secret was typed at all. */
function fills(): { selector: string }[] {
  if (!fs.existsSync(ctx.cmdLog)) return [];
  return fs
    .readFileSync(ctx.cmdLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { action: string; selector?: string })
    .filter((c) => c.action === "fill")
    .map((c) => ({ selector: c.selector! }));
}

/** The broker's own audit lines — RELEASED means it was asked for, and handed
 * over, a value. */
function brokerLines(): string[] {
  if (!fs.existsSync(ctx.brokerLog)) return [];
  return fs.readFileSync(ctx.brokerLog, "utf8").trim().split("\n").filter(Boolean);
}
const released = (): string[] => brokerLines().filter((l) => l.includes("RELEASED"));

afterEach(async () => {
  await ctx.sessions.closeAll("teardown");
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

describe("fill_secret financial gate — blocking", () => {
  // Both a plain denial and an approval-service failure must block: the
  // enforcement treats not-approved, error, timeout and absent-endpoint alike.
  it.each([
    { what: "the owner has not approved", approval: { approved: false } as const },
    { what: "the approval service errors", approval: "throw" as const },
    { what: "no approval endpoint is wired (the shipping default)", approval: "default" as const },
  ])("refuses a bank credential when $what", async ({ approval }) => {
    ctx = makeCtx(approval);
    const handle = await sessionAt(BANK_URL);
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
    // Recorded as a denial, and no secret leaked into the result or the audit.
    expect(ctx.events.at(-1)?.event).toBe("credential_denied");
    expect(ctx.events.at(-1)?.fields.reason).toBe(
      "banking credential release requires owner approval; none found",
    );
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(ctx.events)).not.toContain("hunter2");
  });

  it("fails closed when the destination host cannot be read", async () => {
    // An unreadable destination cannot be ruled out as a bank, so nothing is
    // released — the strongest fail-closed: refused before it can even be
    // classified. `#card*` selectors take the frame_url the fixture is told to
    // report; a garbage one has no host.
    ctx = makeCtx({ approved: true }, { FAKE_CARD_FRAME_URL: "not-a-url" });
    const handle = await sessionAt(BANK_URL);
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret",
      selector: "#card-x",
      item: "B1",
      field: "password",
    });
    expect(jv(result).get("status").str).toBe("error");
    expect(released()).toEqual([]);
    expect(fills()).toEqual([]);
    expect(JSON.stringify(ctx.events)).not.toContain("hunter2");
  });
});

describe("fill_secret financial gate — release", () => {
  it("releases a bank credential once the owner has approved", async () => {
    ctx = makeCtx({ approved: true });
    const handle = await sessionAt(BANK_URL);
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret",
      selector: "#pass",
      item: "B1",
      field: "password",
    });
    expect(result).toEqual({ status: "completed", ok: true, frame: 0 });
    // The gate was consulted for this session + destination …
    expect(ctx.approvalCalls).toHaveLength(1);
    expect(ctx.approvalCalls[0].domain).toBe("chase.com");
    // … and, on approval, the vault WAS asked and the field filled, on the bank page.
    expect(released().length).toBe(1);
    expect(released()[0]).toContain("page=chase.com");
    expect(fills()).toEqual([{ selector: "#pass" }]);
    expect(ctx.events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["credential_payment_approved", "credential_filled"]),
    );
  });

  it("never consults the gate for a non-financial destination", async () => {
    // A plain login on a plain site behaves exactly as before: the approval
    // client is not even asked, and the release proceeds.
    ctx = makeCtx({ approved: false }); // would block IF it were consulted
    const handle = await sessionAt(PLAIN_URL);
    const result = await ctx.sessions.command(handle, {
      action: "fill_secret",
      selector: "#pass",
      item: "L1",
      field: "password",
    });
    expect(result).toEqual({ status: "completed", ok: true, frame: 0 });
    expect(ctx.approvalCalls).toEqual([]);
    expect(released().length).toBe(1);
    expect(fills()).toEqual([{ selector: "#pass" }]);
  });
});

describe("assessFinancialRelease", () => {
  it.each([
    { what: "a bank domain", host: "chase.com", gated: true },
    { what: "a subdomain of a bank", host: "secure.chase.com", gated: true },
    { what: "sofi.com, named in the spec", host: "sofi.com", gated: true },
    { what: "an unrelated site", host: "pizza.example", gated: false },
    // A look-alike must NOT match: suffix matching is on label boundaries.
    { what: "a look-alike that only ends in the name", host: "notchase.com", gated: false },
    { what: "a bank name used as a subdomain of another site", host: "chase.com.evil.com", gated: false },
  ])("gates $what: $gated", ({ host, gated }) => {
    expect(assessFinancialRelease(host).gated).toBe(gated);
  });

  it("fails closed on an unreadable host", () => {
    expect(assessFinancialRelease(null).gated).toBe(true);
    expect(assessFinancialRelease("").gated).toBe(true);
    expect(assessFinancialRelease(null).domain).toBeNull();
  });
});

describe("the shipping default approval client", () => {
  it("approves nothing, so financial releases stay blocked until it is replaced", async () => {
    const decision = await NO_APPROVAL_ENDPOINT.checkPaymentApproval({
      sessionId: "s",
      domain: "chase.com",
    });
    expect(decision.approved).toBe(false);
  });
});
