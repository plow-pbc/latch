/**
 * The enforcement core: origin scope on goto, post-action checks, popup
 * lockout, extend, the fill_secret gate chain, and that no secret value ever
 * appears in results or the audit stream.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSONValue, jv } from "@domo/protocol";
import { BrowserHostConfig, BrowserSessions, CredentialBroker } from "@domo/device-core";

const FAKE_SERVER = fileURLToPath(
  new URL("../../../e2e/fixtures/fakeBrowserServer.cjs", import.meta.url),
);
const FAKE_BROKER = fileURLToPath(new URL("../../../e2e/fixtures/fakeVaultBroker.cjs", import.meta.url));

interface Ctx {
  sessions: BrowserSessions;
  browsers: BrowserHostConfig;
  events: { event: string; fields: { [k: string]: JSONValue } }[];
  dir: string;
  fillLog: string;
  cmdLog: string;
}

let ctx: Ctx;

function makeCtx(serverEnv: Record<string, string> = {}): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-bs-"));
  const fillLog = path.join(dir, "fills.log");
  const cmdLog = path.join(dir, "commands.log");
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
        descriptors: [{ label: "password", hidden: true, custom: false, alias: false }, { label: "username", hidden: false, custom: false, alias: false }],
        values: { password: "hunter2", username: "jon" },
      },
      {
        id: "C1",
        title: "Visa",
        category: "CREDIT_CARD",
        username: "",
        urls: [],
        descriptors: [{ label: "number", hidden: true, custom: false, alias: false }, { label: "cvv", hidden: true, custom: false, alias: true }],
        values: { number: "4111111111111111", cvv: "123" },
      },
      {
        id: "X1",
        title: "Other Site",
        category: "LOGIN",
        username: "x",
        urls: ["https://elsewhere.example/"],
        descriptors: [{ label: "password", hidden: true, custom: false, alias: false }],
        values: { password: "sekret" },
      },
    ]),
  );
  const events: Ctx["events"] = [];
  const audit = (event: string, fields: { [k: string]: JSONValue }) =>
    events.push({ event, fields });
  // One browser per session, exactly as the app runs it.
  const browsers = {
    command: ["node", FAKE_SERVER],
    env: { FAKE_FILL_LOG: fillLog, FAKE_CMD_LOG: cmdLog, ...serverEnv },
    screenshotsDir: path.join(dir, "shots"),
    profileDir: path.join(dir, "profiles"),
    audit,
  };
  const credentials = new CredentialBroker({
    command: ["node", FAKE_BROKER],
    env: { FAKE_BROKER_VAULT: vaultPath },
  });
  const sessions = new BrowserSessions(browsers, credentials, audit, 60_000);
  return { sessions, browsers, events, dir, fillLog, cmdLog };
}

beforeEach(() => {
  ctx = makeCtx();
});
afterEach(async () => {
  await ctx.sessions.closeAll("test");
});

const AGENT = "agent-1";

/** The refusal "#blocked-later" scripts: it settles after the click answered,
 * so it arrives on the owner's viewer poll with no action left to carry it. */
const LATE_REFUSAL = {
  status: 401, method: "GET",
  origin: "https://pizza.example", initiator: "https://pizza.example",
};

/** Leave that refusal in the device, held for whatever comes next. */
async function holdLateRefusal(sessions: BrowserSessions, handle: string) {
  await sessions.command(handle, { action: "goto", url: "https://pizza.example/" });
  await sessions.command(handle, { action: "click", selector: "#blocked-later" });
  // The browser is up: the viewer can see the session that just acted.
  expect(await sessions.viewFrame()).not.toBeNull();
}

async function openSession(origins: string[]): Promise<string> {
  const r = jv(await ctx.sessions.open("int-1", AGENT, origins));
  expect(r.get("status").str).toBe("completed");
  return r.get("session").str!;
}

function eventNames(): string[] {
  return ctx.events.map((e) => e.event);
}

describe("session lifecycle", () => {
  it("open → command → close, audited", async () => {
    const s = await openSession(["pizza.example"]);
    const r = jv(await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/menu" }));
    expect(r.get("status").str).toBe("completed");
    await ctx.sessions.close(s, "agent");
    expect(eventNames()).toEqual(
      expect.arrayContaining([
        "browser_session_opened",
        "browser_started",
        "browser_navigated",
        "browser_command",
        "browser_session_closed",
      ]),
    );
  });

  it("a crash closes the session's books instead of leaving it open forever", async () => {
    const s = await openSession(["pizza.example"]);
    // A refusal the device is holding when the browser dies belongs on the
    // closing line as much as on an orderly close.
    await holdLateRefusal(ctx.sessions, s);
    // What the session's own host.onCrash wiring calls when that browser dies.
    // It names the session, because only one of them lost its browser.
    ctx.sessions.noteCrash(s);
    const closed = ctx.events.find((e) => e.event === "browser_session_closed");
    // The audit names the session by a one-way digest: the handle is a
    // capability, and the log is read by the owner, by an agent's history and
    // by the reviewer model off this Mac.
    expect(closed?.fields.session).not.toBe(s);
    expect(String(closed?.fields.session)).toMatch(/^[a-f0-9]{16}$/);
    expect(closed?.fields.reason).toBe("crashed");
    expect(closed?.fields.failed_requests).toEqual([LATE_REFUSAL]);
    expect(ctx.sessions.current()).toBeNull();
    // The handle died with the browser.
    const r = jv(await ctx.sessions.command(s, { action: "url" }));
    expect(r.get("status").str).toBe("error");
  });

  it("exposes current() for the owner's live-browser view", async () => {
    expect(ctx.sessions.current()).toBeNull();

    const s = await openSession(["pizza.example"]);
    expect(ctx.sessions.current()).toMatchObject({
      origins: ["pizza.example"],
      agentId: AGENT,
      inScope: true,
    });

    // A click that wanders off-scope flips the viewer's inScope flag.
    await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/" });
    await ctx.sessions.command(s, { action: "click", selector: "#offsite" });
    expect(ctx.sessions.current()).toMatchObject({
      lastUrl: "https://offsite.example/lander",
      inScope: false,
    });

    await ctx.sessions.close(s, "test");
    expect(ctx.sessions.current()).toBeNull();
  });


  it("rejects a command for a session that is not open", async () => {
    await openSession(["pizza.example"]);
    const wrongHandle = jv(await ctx.sessions.command("nope", { action: "url" }));
    expect(wrongHandle.get("status").str).toBe("error");
  });

  it("says so plainly when the Mac is already running as many browsers as it will", async () => {
    // The cap is a real limit — a Camoufox is a window and a few hundred MB —
    // so it is stated rather than enforced by throwing somebody else out. It
    // is tested at its real value: no knob, no seam.
    const handles: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = jv(await ctx.sessions.open(`int-${i}`, `capped-${i}`, ["pizza.example"]));
      expect(r.get("status").str).toBe("completed");
      handles.push(r.get("session").str!);
    }
    const tooMany = jv(await ctx.sessions.open("int-9", "capped-9", ["a.example"]));
    expect(tooMany.get("status").str).toBe("error");
    expect(tooMany.get("error").str).toContain("already running 8 browsers");
    // And the three that were here first are untouched.
    for (const [i, h] of handles.entries()) {
      expect(jv(await ctx.sessions.command(h, { action: "url" })).get("status").str)
        .toBe("completed");
    }
  });

  it("gives a second caller on the same credential its own browser, not the first one's", async () => {
    // Several agents reach this Mac through ONE Plow credential — that is how
    // the owner's agents are set up. Keying a session on the credential made
    // two agents one: the second was refused and told to reuse the first's
    // session, and then drove it. Every open is its own browser now.
    const first = await openSession(["pizza.example"]);
    const r = jv(await ctx.sessions.open("int-2", AGENT, ["b.example"]));
    expect(r.get("status").str).toBe("completed");
    const second = r.get("session").str!;
    expect(second).not.toBe(first);

    // Each drives its own page; neither moves the other's.
    await ctx.sessions.command(first, { action: "goto", url: "https://pizza.example/one" });
    await ctx.sessions.command(second, { action: "goto", url: "https://b.example/two" });
    expect(jv(await ctx.sessions.command(first, { action: "url" })).get("url").str)
      .toBe("https://pizza.example/one");
    expect(jv(await ctx.sessions.command(second, { action: "url" })).get("url").str)
      .toBe("https://b.example/two");

    // Two live sessions on one credential never share a profile directory:
    // Firefox locks a profile against a second copy of itself.
    const profiles = fs.readdirSync(path.join(ctx.dir, "profiles"));
    expect(profiles.length).toBe(2);
    // Both are the session's own and both go when it closes: nothing durable
    // is kept for a credential several agents share, or the next one to open
    // would mount the last one's cookies.
    expect(profiles.every((p) => p.startsWith("session-"))).toBe(true);

    // Closing one leaves the other browsing, and takes only its own profile.
    await ctx.sessions.close(second, "test");
    expect(fs.readdirSync(path.join(ctx.dir, "profiles")).length).toBe(1);
    expect(jv(await ctx.sessions.command(first, { action: "url" })).get("url").str)
      .toBe("https://pizza.example/one");
  });

  it("open warms the browser up front (so no later action pays the cold start)", async () => {
    // The fake server's ready line audits browser_started; it must land at open,
    // before any browser command runs.
    await openSession(["pizza.example"]);
    expect(eventNames()).toContain("browser_started");
    expect(eventNames()).not.toContain("browser_command");
  });

  it("clamps an over-long wait so one exchange can't outrun the relay ceiling", async () => {
    const s = await openSession(["pizza.example"]);
    const r = jv(await ctx.sessions.command(s, { action: "wait", seconds: 45 }));
    expect(r.get("status").str).toBe("completed");
    expect(r.get("seconds").num).toBe(12); // MAX_WAIT_SECONDS
    const ok = jv(await ctx.sessions.command(s, { action: "wait", seconds: 3 }));
    expect(ok.get("seconds").num).toBe(3); // a reasonable wait passes through
  });

  it("lets a click ask for more time, bounded like a wait", async () => {
    const s = await openSession(["pizza.example"]);
    const clicks: [Record<string, JSONValue>, JSONValue | undefined][] = [
      [{ timeout_ms: 8000 }, 8000],
      [{ timeout_ms: 45_000 }, 11_000], // capped inside the exchange
      // Playwright reads 0 as "no timeout" — the floor is what keeps a click
      // from parking until the host cap kills the browser under it.
      [{ timeout_ms: 0 }, 500],
      [{}, undefined], // asked for nothing, told the browser nothing
    ];
    for (const [extra] of clicks) {
      const r = jv(await ctx.sessions.command(s, { action: "click", selector: "#go", ...extra }));
      expect(r.get("status").str).toBe("completed");
    }
    // The knob belongs to no other action.
    await ctx.sessions.command(s, { action: "scroll", timeout_ms: 9000 });

    const sent = fs
      .readFileSync(ctx.cmdLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { action: string; timeout_ms?: number });
    expect(sent.filter((c) => c.action === "click").map((c) => c.timeout_ms))
      .toEqual(clicks.map(([, want]) => want));
    expect(sent.find((c) => c.action === "scroll")!.timeout_ms).toBeUndefined();

    // And the audit log says which clicks needed it — including, above all, the
    // ones that failed, which are what a look at a bad session goes looking for.
    const swallowed = jv(await ctx.sessions.command(s, {
      action: "click", selector: "#swallowed", timeout_ms: 6000,
    }));
    expect(swallowed.get("status").str).toBe("error");
    const audited = ctx.events.filter((e) => e.event === "browser_command");
    expect(audited.filter((e) => e.fields.timeout_ms === 11_000)).toHaveLength(1);
    const failure = audited.at(-1)!.fields;
    expect(failure.timeout_ms).toBe(6000);
    expect(String(failure.error)).toContain("intercepts pointer events");
  });
});

describe("origin scope", () => {
  it("refuses goto outside the approved origins before navigating", async () => {
    const s = await openSession(["pizza.example"]);
    const r = jv(await ctx.sessions.command(s, { action: "goto", url: "https://evil.example/" }));
    expect(r.get("status").str).toBe("error");
    expect(r.get("error").str).toContain("outside the approved origins");
    expect(eventNames()).toContain("browser_scope_violation");
    // The browser never navigated: current url is still blank.
    const u = jv(await ctx.sessions.command(s, { action: "url" }));
    expect(u.get("url").str).toBe("about:blank");
  });

  it("wildcards match subdomains", async () => {
    const s = await openSession(["*.pizza.example", "pizza.example"]);
    const r = jv(
      await ctx.sessions.command(s, { action: "goto", url: "https://www.pizza.example/x" }),
    );
    expect(r.get("status").str).toBe("completed");
  });

  it("locks content actions after a click lands out of scope, and strips content from the landing result", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/" });
    // Scripted: "#offsite" navigates to https://offsite.example/lander.
    const clicked = jv(await ctx.sessions.command(s, { action: "click", selector: "#offsite" }));
    expect(clicked.get("status").str).toBe("completed");
    expect(clicked.get("out_of_scope").str).toBe("offsite.example");

    const text = jv(await ctx.sessions.command(s, { action: "text" }));
    expect(text.get("status").str).toBe("error");
    expect(text.get("error").str).toContain("offsite.example");
    const shot = jv(await ctx.sessions.command(s, { action: "screenshot" }));
    expect(shot.get("status").str).toBe("error");

    // Way back is allowed.
    const back = jv(
      await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/" }),
    );
    expect(back.get("status").str).toBe("completed");
    const text2 = jv(await ctx.sessions.command(s, { action: "text" }));
    expect(text2.get("status").str).toBe("completed");
  });

  it("audits popups and allows use_page + extend to reach them", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/" });
    await ctx.sessions.command(s, { action: "click", selector: "#popup" });
    const navs = ctx.events.filter((e) => e.event === "browser_navigated");
    expect(JSON.stringify(navs)).toContain("popup.example");

    // Switch to the popup: content locked until scope is widened.
    await ctx.sessions.command(s, { action: "use_page", index: 1 });
    const locked = jv(await ctx.sessions.command(s, { action: "text" }));
    expect(locked.get("status").str).toBe("error");

    const ext = jv(ctx.sessions.extend("int-2", s, ["popup.example"], []));
    expect(ext.get("status").str).toBe("completed");
    const text = jv(await ctx.sessions.command(s, { action: "text" }));
    expect(text.get("status").str).toBe("completed");
    expect(eventNames()).toContain("browser_session_extended");
  });
});

describe("requests the site refused", () => {
  const ORDER = { status: 429, method: "POST", host: "pizza.example", retry_after: "30" };

  it("tells the agent the host, and only when both ends were approved", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/" });
    // Scripted: "#blocked" is a click whose XHRs the site answers 429, plus a
    // third-party beacon that 403s.
    const r = jv(await ctx.sessions.command(s, { action: "click", selector: "#blocked" }));
    expect(r.get("status").str).toBe("completed");

    // The agent hears about the approved page's own trouble and nothing else:
    // not the third-party beacon (unapproved destination), not the 404 the
    // locked-out page aimed AT the approved origin (unapproved asker) — which
    // would otherwise read as the approved page's own — and not the 503 the
    // browser could not attribute at all (unnameable asker).
    expect(r.get("failed_requests").value).toEqual([ORDER]);

    // The owner sees all four, with who asked — nobody can mislead them by
    // choosing a url, and an origin is all any of it is. The entry is rebuilt
    // from the fields this side knows, so the browser's stray url is not among
    // them however durable the log is.
    const command = ctx.events.filter((e) => e.event === "browser_command").pop();
    expect(command?.fields.failed_requests).toEqual([
      {
        status: 429, method: "POST", origin: "https://pizza.example",
        initiator: "https://pizza.example", retry_after: "30",
      },
      {
        status: 403, method: "GET", origin: "https://tracker.example",
        initiator: "https://pizza.example",
      },
      {
        status: 404, method: "GET", origin: "https://pizza.example",
        initiator: "https://offsite.example",
      },
      { status: 503, method: "GET", origin: "https://pizza.example", initiator: "" },
    ]);
    expect(JSON.stringify(command?.fields.failed_requests)).not.toContain("token=SECRET");
  });

  it("puts what the device is still holding on the closing line", async () => {
    const s = await openSession(["pizza.example"]);
    // Nothing follows to carry it out, and the owner's log is promised every
    // entry the device received.
    await holdLateRefusal(ctx.sessions, s);
    await ctx.sessions.close(s, "agent");
    const closed = ctx.events.filter((e) => e.event === "browser_session_closed").pop();
    expect(closed?.fields.failed_requests).toEqual([LATE_REFUSAL]);
  });

  it("lets a page's failing frames crowd out the one the agent could have used", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/" });
    // Six on one reply — five frame loads the browser cannot attribute and, as
    // the oldest, the one refusal the agent could have used. The device holds
    // five, so that one is what falls out: the owner is the one who needs the
    // whole picture, and the agent's next action gets whatever comes next.
    await ctx.sessions.command(s, { action: "click", selector: "#frames-fail" });
    expect(await ctx.sessions.viewFrame()).not.toBeNull();
    const r = jv(await ctx.sessions.command(s, { action: "url" }));
    expect(r.get("failed_requests").value).toBeNull();
    const command = ctx.events.filter((e) => e.event === "browser_command").pop();
    expect((command?.fields.failed_requests as { status: number }[]).map((e) => e.status))
      .toEqual([414, 413, 412, 411, 410]);
  });

  it("says nothing when the page's requests were answered", async () => {
    const s = await openSession(["pizza.example"]);
    const r = jv(await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/" }));
    expect(r.get("failed_requests").value).toBeNull();
    const command = ctx.events.filter((e) => e.event === "browser_command").pop();
    expect(command?.fields.failed_requests).toBeUndefined();
  });

  it("keeps what an action saw even when that action failed", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/" });
    // The motivating shape: the click fails BECAUSE the site refused its
    // request, so a report only the success path made would be missing exactly
    // when it matters.
    const r = jv(await ctx.sessions.command(s, { action: "click", selector: "#refuses" }));
    expect(r.get("status").str).toBe("error");
    expect(r.get("error").str).toContain("Timeout");
    expect(r.get("failed_requests").value).toEqual([ORDER]);
    const command = ctx.events.filter((e) => e.event === "browser_command").pop();
    expect(command?.fields.error).toContain("Timeout");
    expect(command?.fields.failed_requests).toHaveLength(4);
  });
});

describe("credentials", () => {
  it("no longer answers vault questions — that moved to the vault tool", async () => {
    const s = await openSession(["pizza.example"]);
    const r = jv(await ctx.sessions.command(s, { action: "credentials" }));
    expect(r.get("status").str).toBe("error");
  });

  it("fill_secret refuses items not approved for the session", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/login" });
    const r = jv(
      await ctx.sessions.command(s, {
        action: "fill_secret",
        selector: "#pass",
        item: "L1",
        field: "password",
      }),
    );
    expect(r.get("status").str).toBe("error");
    expect(r.get("error").str).toContain("not approved");
    expect(eventNames()).toContain("credential_denied");
  });

  it("fill_secret keeps the value out of a FAILED fill too", async () => {
    // The failure path is the common one — wrong element, hidden field, slow
    // render — and Playwright's message quotes what it tried to type. If that
    // reaches the agent, the secret is in model context, transcripts and any
    // provider that sees them.
    const s = await openSession(["pizza.example"]);
    ctx.sessions.extend("int-3", s, [], ["L1"]);
    await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/login" });
    const r = jv(
      await ctx.sessions.command(s, {
        action: "fill_secret",
        selector: "#nofill",
        item: "L1",
        field: "password",
      }),
    );
    expect(r.get("status").str).toBe("error");
    expect(JSON.stringify(r.value)).not.toContain("hunter2");
    expect(JSON.stringify(ctx.events)).not.toContain("hunter2");
    // Still says enough to fix the call.
    expect(r.get("error").str).toContain("#nofill");
    expect(eventNames()).toContain("credential_fill_failed");
  });

  it("fill_secret types the value on-device and never returns it", async () => {
    const s = await openSession(["pizza.example"]);
    ctx.sessions.extend("int-2", s, [], ["L1"]);
    await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/login" });
    const r = jv(
      await ctx.sessions.command(s, {
        action: "fill_secret",
        selector: "#pass",
        item: "L1",
        field: "password",
      }),
    );
    expect(r.get("status").str).toBe("completed");
    // The secret reached the browser fill...
    expect(fs.readFileSync(ctx.fillLog, "utf8")).toContain("#pass\thunter2");
    // ...but appears nowhere in the result or the audit stream.
    expect(JSON.stringify(r.value)).not.toContain("hunter2");
    expect(JSON.stringify(ctx.events)).not.toContain("hunter2");
    const filled = ctx.events.find((e) => e.event === "credential_filled")!;
    expect(filled.fields.item).toBe("L1");
    expect(filled.fields.origin).toBe("pizza.example");
  });

  it("fill_secret is refused when the item belongs to another site (op origin check)", async () => {
    const s = await openSession(["pizza.example"]);
    ctx.sessions.extend("int-2", s, [], ["X1"]);
    await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/login" });
    const r = jv(
      await ctx.sessions.command(s, {
        action: "fill_secret",
        selector: "#pass",
        item: "X1",
        field: "password",
      }),
    );
    expect(r.get("status").str).toBe("error");
    expect(r.get("error").str).toContain("refused");
    expect(JSON.stringify(ctx.events)).not.toContain("sekret");
    const denied = ctx.events.filter((e) => e.event === "credential_denied");
    expect(JSON.stringify(denied)).toContain("VaultDenied");
  });

  it("fill_secret refuses frames outside the session scope, allows approved card frames", async () => {
    const s = await openSession(["pizza.example"]);
    ctx.sessions.extend("int-2", s, [], ["C1"]);
    await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/checkout" });
    // Scripted: "#card*" selectors live in a frame on payframe.example.
    const denied = jv(
      await ctx.sessions.command(s, {
        action: "fill_secret",
        selector: "#card-number",
        item: "C1",
        field: "number",
      }),
    );
    expect(denied.get("status").str).toBe("error");
    expect(denied.get("error").str).toContain("payframe.example");

    ctx.sessions.extend("int-3", s, ["payframe.example"], []);
    const ok = jv(
      await ctx.sessions.command(s, {
        action: "fill_secret",
        selector: "#card-number",
        item: "C1",
        field: "number",
      }),
    );
    expect(ok.get("status").str).toBe("completed");
    expect(ok.get("frame").int).toBe(1);
    expect(fs.readFileSync(ctx.fillLog, "utf8")).toContain("#card-number\t4111111111111111\t1");
  });
});

describe("audit hygiene", () => {
  it("strips query strings from audited URLs", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(s, {
      action: "goto",
      url: "https://pizza.example/cb?token=SECRETTOKEN#frag",
    });
    const all = JSON.stringify(ctx.events);
    expect(all).not.toContain("SECRETTOKEN");
    expect(all).toContain("https://pizza.example/cb");
  });
});

describe("access the owner's log could not record is not granted", () => {
  /** A session store whose audit append fails once for one event, as a full
   * disk or a bad permission would. */
  function failingAudit(failOn: string): BrowserSessions {
    let fired = false;
    return new BrowserSessions(
      ctx.browsers,
      null,
      (event: string) => {
        if (event === failOn && !fired) {
          fired = true; // fails once, so a retry can be observed
          throw new Error("audit append failed");
        }
      },
      60_000,
    );
  }

  it("does not widen a session it could not record", async () => {
    const sessions = failingAudit("browser_session_extended");
    const opened = jv(await sessions.open("int-1", AGENT, ["pizza.example"]));
    const handle = opened.get("session").str!;

    expect(() =>
      sessions.extend("int-2", handle, ["paypal.example"], ["L1"]),
    ).toThrow(/audit append failed/);

    // The agent must not be left holding origins and credential items that the
    // owner's log has no event for — that is access they cannot see.
    const live = sessions.current()!;
    expect(live.origins).toEqual(["pizza.example"]);
    expect(live.origins).not.toContain("paypal.example");
    await sessions.closeAll("test");
  });

  it("does not open a session it could not record, and stays usable after", async () => {
    const sessions = failingAudit("browser_session_opened");
    await expect(sessions.open("int-1", AGENT, ["pizza.example"])).rejects.toThrow(
      /audit append failed/,
    );
    // A live session with no opening event is a browser being used that the
    // owner cannot see at all — the bug this PR exists to close.
    expect(sessions.current()).toBeNull();
    // ...and the browser itself must not be left running: open() warms it
    // before it audits, and headed means a window is already on screen.
    expect(ctx.sessions.current()).toBeNull();

    // Nor may the cleanup latch the host shut. shutdown() sets `shuttingDown`
    // and only resetBreaker() clears it, so a retry could publish a session
    // whose every command then failed with "browser host is shut down" — a
    // successful open the agent cannot use.
    const retry = jv(await sessions.open("int-1", AGENT, ["pizza.example"]));
    expect(retry.get("status").str).toBe("completed");
    const r = jv(
      await sessions.command(retry.get("session").str!, {
        action: "goto",
        url: "https://pizza.example/",
      }),
    );
    expect(r.get("status").str).toBe("completed");
    await sessions.closeAll("test");
  });

  it("does not latch the browser shut when closing could not be recorded", async () => {
    // browser_stopped is audited by the HOST, on its way out of shutdown() —
    // so a failing append there throws between shutdown() and the breaker
    // reset. close() is the everyday path, which makes this the likeliest way
    // to reach an unusable browser.
    let fired = false;
    const browsers = {
      command: ["node", FAKE_SERVER],
      env: {},
      screenshotsDir: path.join(ctx.dir, "shots2"),
      audit: (event: string) => {
        if (event === "browser_stopped" && !fired) {
          fired = true;
          throw new Error("audit append failed");
        }
      },
    };
    const events: Ctx["events"] = [];
    const sessions = new BrowserSessions(browsers, null, (event, fields) => events.push({ event, fields }), 60_000);
    const handle = jv(await sessions.open("int-1", AGENT, ["pizza.example"]))
      .get("session")
      .str!;
    // A refusal the device is holding when the shutdown throws is exactly when
    // the last thing the page said is worth having, so the closing line is
    // written either way.
    await holdLateRefusal(sessions, handle);
    await expect(sessions.close(handle, "agent")).rejects.toThrow(/audit append failed/);
    const closed = events.filter((e) => e.event === "browser_session_closed").pop();
    expect(closed?.fields.failed_requests).toEqual([LATE_REFUSAL]);

    const retry = jv(await sessions.open("int-2", AGENT, ["pizza.example"]));
    expect(retry.get("status").str).toBe("completed");
    const r = jv(
      await sessions.command(retry.get("session").str!, {
        action: "goto",
        url: "https://pizza.example/",
      }),
    );
    expect(r.get("status").str).toBe("completed");
    await sessions.closeAll("test");
  });
});

describe("the handle is a capability, so the log never carries it", () => {
  it("keeps the raw handle out of every audit event", async () => {
    // The audit file is read by the owner, selected into an agent's history,
    // and serialised into the reviewer prompt that leaves this Mac. A handle
    // there is a browser anybody who reads it can drive.
    const s = await openSession(["pizza.example"]);
    ctx.sessions.extend("int-2", s, ["b.example"], ["L1"]);
    await ctx.sessions.command(s, { action: "goto", url: "https://pizza.example/menu" });
    await ctx.sessions.command(s, { action: "eval", expression: "1" });
    await ctx.sessions.close(s, "test");

    expect(JSON.stringify(ctx.events)).not.toContain(s);
    // …and every line still names the session, so they can be read together.
    const named = ctx.events.filter((e) => typeof e.fields.session === "string");
    expect(named.length).toBeGreaterThan(3);
    for (const e of named) expect(String(e.fields.session)).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("every browser opens as the user, already signed in", () => {
  const PYTHON = process.env.DOMO_TEST_PYTHON ?? "python3";
  /** The program the app ships and runs for real. */
  const MERGE_SCRIPT = fileURLToPath(
    new URL("../../../vendor/browser-server/merge_cookies.py", import.meta.url),
  );

  /** A real Firefox-shaped cookie store holding the sites named.
   *
   * `host` or `host=value` — the value is what a refreshed token changes and a
   * read does not, which is what the merge has to tell apart. */
  const cookieStore = (file: string, hosts: string[], usedAt = 1, expiry = 0): void => {
    const rows = hosts
      .map((h, i) => {
        const [host, value = "yes"] = h.split("=");
        return `('sid','${value}','${host}','/',${expiry},${usedAt + i},1,1,1,0,0,0,1,'')`;
      })
      .join(",");
    execFileSync(PYTHON, [
      "-c",
      `import sqlite3,sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE IF NOT EXISTS moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT,"
  " host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER,"
  " isHttpOnly INTEGER, inBrowserElement INTEGER, sameSite INTEGER, rawSameSite INTEGER, schemeMap INTEGER,"
  " originAttributes TEXT, CONSTRAINT moz_uniqueid UNIQUE (name, host, path, originAttributes))")
db.execute("INSERT OR REPLACE INTO moz_cookies (name,value,host,path,expiry,lastAccessed,creationTime,"
  "isSecure,isHttpOnly,inBrowserElement,sameSite,rawSameSite,schemeMap,originAttributes) VALUES ${rows}")
db.commit()`,
      file,
    ]);
  };

  /** Which sites a profile is signed into, and with what. */
  const signedInto = (dir: string, withValues = false): string[] =>
    execFileSync(PYTHON, [
      "-c",
      `import sqlite3,sys
rows = sqlite3.connect(sys.argv[1]).execute("SELECT host, value FROM moz_cookies ORDER BY host")
show = len(sys.argv) > 2
print("\\n".join((h + "=" + v) if show else h for h, v in rows))`,
      path.join(dir, "cookies.sqlite"),
      ...(withValues ? ["values"] : []),
    ])
      .toString()
      .split("\n")
      .filter(Boolean);

  /**
   * Sessions cloned from a profile that is already signed in somewhere.
   *
   * `signedInto` says which sites the user's profile starts with — none of
   * them means a Mac whose owner has never browsed here — and `merger` stands
   * in for a runtime whose merge program is missing or broken.
   */
  const signedIn = (
    opts: { has?: string[]; merger?: string[]; audit?: AuditFn } = {},
  ): { sessions: BrowserSessions; seed: string; profiles: string } => {
    const home = fs.mkdtempSync(path.join(ctx.dir, "signed-in-"));
    const seed = path.join(home, "profile");
    const has = opts.has ?? ["his.example"];
    if (has.length) {
      fs.mkdirSync(seed, { recursive: true });
      cookieStore(path.join(seed, "cookies.sqlite"), has);
      fs.writeFileSync(path.join(seed, ".parentlock"), "held by the browser that made it");
    }
    return {
      sessions: new BrowserSessions(
        {
          ...ctx.browsers,
          profileDir: path.join(home, "profiles"),
          seedProfile: seed,
          mergeCookiesCommand: opts.merger ?? [PYTHON, MERGE_SCRIPT],
        },
        null,
        opts.audit ?? (() => {}),
        60_000,
      ),
      seed,
      profiles: path.join(home, "profiles"),
    };
  };

  /** When a cookie in a profile runs out. */
  const expiryOf = (dir: string, host: string): number =>
    Number(
      execFileSync(PYTHON, [
        "-c",
        `import sqlite3,sys
print(sqlite3.connect(sys.argv[1]).execute("SELECT expiry FROM moz_cookies WHERE host = ?", (sys.argv[2],)).fetchone()[0])`,
        path.join(dir, "cookies.sqlite"),
        host,
      ])
        .toString()
        .trim(),
    );

  /** Signed out inside a session: the cookie is gone from its clone. */
  const signOut = (file: string, host: string): void => {
    execFileSync(PYTHON, [
      "-c",
      `import sqlite3,sys
db = sqlite3.connect(sys.argv[1])
db.execute("DELETE FROM moz_cookies WHERE host = ?", (sys.argv[2],))
db.commit()`,
      file,
      host,
    ]);
  };

  /** The one profile directory a session made, whichever it is. */
  const only = (profiles: string): string => path.join(profiles, fs.readdirSync(profiles)[0]);

  it("opens with the user's cookies, and two at once both have them", async () => {
    // The whole point of the pivot: this Mac is one person's, and a browser
    // that opens signed out is a browser they have to sign in again.
    const { sessions, profiles } = signedIn();
    for (const i of [1, 2]) {
      expect(jv(await sessions.open(`int-${i}`, `agent-${i}`, ["pizza.example"])).get("status").str)
        .toBe("completed");
    }
    const dirs = fs.readdirSync(profiles);
    expect(dirs).toHaveLength(2);
    for (const dir of dirs) {
      expect(signedInto(path.join(profiles, dir))).toEqual(["his.example"]);
      // Firefox locks a profile to one process; the copy must not carry the
      // lock of whichever browser held the original.
      expect(fs.existsSync(path.join(profiles, dir, ".parentlock"))).toBe(false);
    }
    await sessions.closeAll("test");
  });

  it("keeps what BOTH browsers signed into, and the user's own logins with them", async () => {
    // Handing whole profiles back made the last browser to close decide what
    // the user was signed into; the other one's sign-in was simply gone. Two
    // browsers, two different sites, and the user keeps all three logins.
    const { sessions, seed, profiles } = signedIn();
    const first = jv(await sessions.open("int-1", AGENT, ["a.example"])).get("session").str!;
    const dirs = fs.readdirSync(profiles);
    const second = jv(await sessions.open("int-2", AGENT, ["b.example"])).get("session").str!;
    const secondDir = fs.readdirSync(profiles).find((d) => !dirs.includes(d))!;
    // Each signs into its own site, inside its own browser.
    cookieStore(path.join(profiles, dirs[0], "cookies.sqlite"), ["a.example"], 50);
    cookieStore(path.join(profiles, secondDir, "cookies.sqlite"), ["b.example"], 60);

    await sessions.close(first, "agent");
    await sessions.close(second, "agent");
    expect(signedInto(seed)).toEqual(["a.example", "b.example", "his.example"]);
    expect(fs.readdirSync(profiles)).toEqual([]);
  });

  it("does not let a browser that only READ a site undo one that signed in again", async () => {
    // Reading a page moves a cookie's timestamp. Merging on "more recently
    // used" alone let a browser that touched nothing put its months-old copy
    // of a token over the fresh one another browser had just been given —
    // signing the user out by doing nothing.
    const { sessions, seed, profiles } = signedIn({ has: ["site.example=old-token"] });
    const refreshed = jv(await sessions.open("int-1", AGENT, ["a.example"])).get("session").str!;
    const refreshedDir = only(profiles);
    const stale = jv(await sessions.open("int-2", AGENT, ["a.example"])).get("session").str!;
    const staleDir = path.join(profiles, fs.readdirSync(profiles).find((d) => path.join(profiles, d) !== refreshedDir)!);

    // One session is handed a new token; the other only reads the same site,
    // which moves its timestamp past the first's without changing anything.
    cookieStore(path.join(refreshedDir, "cookies.sqlite"), ["site.example=new-token"], 50);
    cookieStore(path.join(staleDir, "cookies.sqlite"), ["site.example=old-token"], 90);

    await sessions.close(refreshed, "agent");
    await sessions.close(stale, "agent");
    expect(signedInto(seed, true)).toEqual(["site.example=new-token"]);
  });

  it("carries a renewal that kept the same value, and a sign-out", async () => {
    // "Changed" is not just a new value: a site that pushes the same token
    // out by a month renews the expiry, and a logout removes the row
    // altogether. Both are things the session did, and both have to land.
    const { sessions, seed, profiles } = signedIn({ has: ["renewed.example", "leaving.example"] });
    const handle = jv(await sessions.open("int-1", AGENT, ["a.example"])).get("session").str!;
    const store = path.join(only(profiles), "cookies.sqlite");
    cookieStore(store, ["renewed.example"], 50, 99_999);
    signOut(store, "leaving.example");

    await sessions.close(handle, "agent");
    expect(signedInto(seed)).toEqual(["renewed.example"]);
    expect(expiryOf(seed, "renewed.example")).toBe(99_999);
  });

  it("keeps a first sign-in on a Mac whose owner has no profile yet", async () => {
    // Nothing to merge into is the one case where returning early would lose
    // the login outright — and it is every machine's first session. Two of
    // them can also be open at once, on the same site: the first close makes
    // the profile, and the second must not put its older token over the newer.
    const { sessions, seed, profiles } = signedIn({ has: [] });
    const newer = jv(await sessions.open("int-1", AGENT, ["a.example"])).get("session").str!;
    const newerDir = only(profiles);
    const older = jv(await sessions.open("int-2", AGENT, ["a.example"])).get("session").str!;
    const olderDir = path.join(profiles, fs.readdirSync(profiles).find((d) => path.join(profiles, d) !== newerDir)!);
    cookieStore(path.join(newerDir, "cookies.sqlite"), ["first.example=new-token"], 90);
    cookieStore(path.join(olderDir, "cookies.sqlite"), ["first.example=old-token"], 10);

    await sessions.close(newer, "agent");
    await sessions.close(older, "agent");
    expect(signedInto(seed, true)).toEqual(["first.example=new-token"]);
  });

  it("keeps the session's copy when the merge fails, rather than deleting the only one", async () => {
    // A swallowed merge failure that also removed the clone would lose the
    // sign-in silently — the exact thing this feature exists to prevent.
    const events: string[] = [];
    const { sessions, seed, profiles } = signedIn({
      merger: [PYTHON, "-c", "raise SystemExit('disk is full')"],
      audit: (event) => events.push(event),
    });
    const handle = jv(await sessions.open("int-1", AGENT, ["a.example"])).get("session").str!;
    const dir = only(profiles);
    cookieStore(path.join(dir, "cookies.sqlite"), ["rescue.example"], 50);

    await sessions.close(handle, "agent");
    expect(events).toContain("browser_cookie_merge_failed");
    // Still on disk, still holding the login, and the user's own profile is
    // exactly as it was.
    expect(signedInto(dir)).toContain("rescue.example");
    expect(signedInto(seed)).toEqual(["his.example"]);
  });

  it("waits for a crashed session's cookies before it calls the Mac clear", async () => {
    // A crash is nobody's call, so nothing awaits it — but the quit still
    // must not leave while that session's sign-ins are being written.
    const { sessions, seed, profiles } = signedIn();
    const handle = jv(await sessions.open("int-1", AGENT, ["a.example"])).get("session").str!;
    cookieStore(path.join(only(profiles), "cookies.sqlite"), ["crashed.example"], 50);

    sessions.noteCrash(handle);
    await sessions.closeAll("shutdown");
    expect(signedInto(seed)).toEqual(["crashed.example", "his.example"]);
    expect(fs.readdirSync(profiles)).toEqual([]);
  });

  it("has taken every profile with it by the time a quit's closeAll resolves", async () => {
    // What quitting relies on: it holds the app open until this promise
    // settles, so anything still on disk afterwards outlives the app.
    for (let i = 0; i < 3; i++) await ctx.sessions.open(`int-${i}`, `agent-${i}`, ["a.example"]);
    expect(fs.readdirSync(path.join(ctx.dir, "profiles")).length).toBe(3);

    await ctx.sessions.closeAll("shutdown");
    expect(fs.readdirSync(path.join(ctx.dir, "profiles"))).toEqual([]);
  });

  it("closes once, and nothing calls the Mac clear until that close is done", async () => {
    // A session stays registered while its browser shuts down, so it is still
    // reachable in that window — and a second close, the idle clock coming due
    // and the quit's closeAll all arrive in it. Each used to run its own
    // teardown and write the owner a second "closed" line for one session, and
    // an early answer from closeAll let Electron exit while the browser was
    // still going down, profile and all. The fake browser takes its time here
    // so the window is real.
    const sessions = new BrowserSessions(
      { ...ctx.browsers, env: { ...ctx.browsers.env, FAKE_QUIT_DELAY_MS: "300" } },
      new CredentialBroker({ command: ["node", FAKE_BROKER], env: {} }),
      (event, fields) => ctx.events.push({ event, fields }),
      60_000,
    );
    const handle = jv(await sessions.open("int-1", AGENT, ["a.example"])).get("session").str!;
    const before = ctx.events.length;

    const agentClose = sessions.close(handle, "agent");
    const idleClose = sessions.close(handle, "idle");
    await sessions.closeAll("shutdown");
    expect(fs.readdirSync(path.join(ctx.dir, "profiles"))).toEqual([]);

    await Promise.all([agentClose, idleClose]);
    const closed = ctx.events.slice(before).filter((e) => e.event === "browser_session_closed");
    expect(closed).toHaveLength(1);
    expect(closed[0].fields.reason).toBe("agent");
  });

  it("refuses to open once the app is on its way out", async () => {
    // An intent can sit waiting for the owner and be approved mid-quit. The
    // browser it would start is one nobody is left to close.
    await ctx.sessions.closeAll("shutdown");
    const late = jv(await ctx.sessions.open("int-late", AGENT, ["a.example"]));
    expect(late.get("status").str).toBe("error");
    expect(late.get("error").str).toContain("shutting down");
    // Refused before anything is claimed: no profile, so nothing to leave.
    expect(fs.existsSync(path.join(ctx.dir, "profiles"))).toBe(false);
  });

  it("still closes every session when one of the closes fails", async () => {
    // The app quits on this promise. A close that throws — a full disk on the
    // audit append — must not leave a sibling's profile behind.
    let failed = false;
    const sessions = new BrowserSessions(
      { ...ctx.browsers, audit: () => {} },
      new CredentialBroker({ command: ["node", FAKE_BROKER], env: {} }),
      (event) => {
        if (event === "browser_session_closed" && !failed) {
          failed = true;
          throw new Error("audit log is full");
        }
      },
      60_000,
    );
    for (let i = 0; i < 2; i++) await sessions.open(`int-${i}`, `agent-${i}`, ["a.example"]);

    await expect(sessions.closeAll("shutdown")).rejects.toThrow("audit log is full");
    expect(fs.readdirSync(path.join(ctx.dir, "profiles"))).toEqual([]);
  });
});


describe("three agents, three browsers, at once", () => {
  /**
   * The done condition: each agent drives its OWN browser in parallel, keeps
   * its own page, and nobody is evicted. This fails on a single-browser build
   * three ways — the second open is refused (or closes the first), the three
   * sessions share one active page, and they share one profile.
   */
  it("keeps each session on its own page, its own browser and its own profile", async () => {
    const agents = ["agent-1", "agent-2", "agent-3"];
    const sites = ["a.example", "b.example", "c.example"];

    // Opened in parallel, the way three agents would arrive.
    const opened = await Promise.all(
      agents.map((agent, i) =>
        ctx.sessions.open(`int-${i}`, agent, [sites[i]]).then((r) => jv(r)),
      ),
    );
    const handles = opened.map((r) => {
      expect(r.get("status").str).toBe("completed");
      return r.get("session").str!;
    });
    expect(new Set(handles).size).toBe(3);

    // Driven in parallel, each to its own site.
    await Promise.all(
      handles.map((h, i) =>
        ctx.sessions.command(h, { action: "goto", url: `https://${sites[i]}/page` }),
      ),
    );

    // Each reports ITS page — not the last one anybody navigated.
    const urls = await Promise.all(
      handles.map((h, i) => ctx.sessions.command(h, { action: "url" }).then((r) => jv(r))),
    );
    urls.forEach((r, i) => {
      expect(r.get("status").str).toBe("completed");
      expect(r.get("url").str).toBe(`https://${sites[i]}/page`);
    });

    // Three browsers, three profiles: no shared cookies, no shared logins.
    const profiles = fs.readdirSync(path.join(ctx.dir, "profiles"));
    expect(profiles.length).toBe(3);

    // Closing one leaves the other two browsing.
    await ctx.sessions.close(handles[0], "test");
    for (const i of [1, 2]) {
      const still = jv(await ctx.sessions.command(handles[i], { action: "url" }));
      expect(still.get("url").str).toBe(`https://${sites[i]}/page`);
    }
  });
});
