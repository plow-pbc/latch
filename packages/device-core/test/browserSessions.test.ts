/**
 * The enforcement core: origin scope on goto, post-action checks, popup
 * lockout, extend, the fill_secret gate chain, and that no secret value ever
 * appears in results or the audit stream.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  browsers: BrowserHostConfig & { legacyProfileDir?: string };
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

async function openSession(origins: string[], metadata = true): Promise<string> {
  const r = jv(await ctx.sessions.open("int-1", AGENT, origins, metadata));
  expect(r.get("status").str).toBe("completed");
  return r.get("session").str!;
}

function eventNames(): string[] {
  return ctx.events.map((e) => e.event);
}

describe("session lifecycle", () => {
  it("open → command → close, audited", async () => {
    const s = await openSession(["pizza.example"]);
    const r = jv(await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/menu" }));
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
    // What the session's own host.onCrash wiring calls when that browser dies.
    // It names the session, because only one of them lost its browser.
    ctx.sessions.noteCrash(s);
    const closed = ctx.events.find((e) => e.event === "browser_session_closed");
    expect(closed?.fields.session).toBe(s);
    expect(closed?.fields.reason).toBe("crashed");
    expect(ctx.sessions.current()).toBeNull();
    // The handle died with the browser.
    const r = jv(await ctx.sessions.command(AGENT, s, { action: "url" }));
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
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" });
    await ctx.sessions.command(AGENT, s, { action: "click", selector: "#offsite" });
    expect(ctx.sessions.current()).toMatchObject({
      lastUrl: "https://offsite.example/lander",
      inScope: false,
    });

    await ctx.sessions.close(s, "test");
    expect(ctx.sessions.current()).toBeNull();
  });

  it("rejects a command from the wrong agent or session", async () => {
    const s = await openSession(["pizza.example"]);
    const wrongAgent = jv(await ctx.sessions.command("intruder", s, { action: "url" }));
    expect(wrongAgent.get("status").str).toBe("error");
    const wrongHandle = jv(await ctx.sessions.command(AGENT, "nope", { action: "url" }));
    expect(wrongHandle.get("status").str).toBe("error");
  });

  it("a second agent opens its own browser instead of being turned away", async () => {
    const first = await openSession(["pizza.example"]);
    const r = jv(await ctx.sessions.open("int-2", "agent-2", ["a.example"], false));
    expect(r.get("status").str).toBe("completed");
    const second = r.get("session").str!;
    expect(second).not.toBe(first);
    // Two sessions, two browsers, and the first one still works.
    expect(jv(await ctx.sessions.command(AGENT, first, { action: "url" })).get("status").str)
      .toBe("completed");
  });

  it("says so plainly when the Mac is already running as many browsers as it will", async () => {
    // The cap is a real limit — a Camoufox is a window and a few hundred MB —
    // so it is stated rather than enforced by throwing somebody else out. It
    // is tested at its real value: no knob, no seam.
    const handles: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = jv(await ctx.sessions.open(`int-${i}`, `capped-${i}`, ["pizza.example"], false));
      expect(r.get("status").str).toBe("completed");
      handles.push(r.get("session").str!);
    }
    const tooMany = jv(await ctx.sessions.open("int-4", "capped-4", ["a.example"], false));
    expect(tooMany.get("status").str).toBe("error");
    expect(tooMany.get("error").str).toContain("already running 3 browsers");
    // And the three that were here first are untouched.
    for (const [i, h] of handles.entries()) {
      expect(jv(await ctx.sessions.command(`capped-${i}`, h, { action: "url" })).get("status").str)
        .toBe("completed");
    }
  });

  it("hands an agent back to the browser it already has instead of opening a second", async () => {
    // One profile has one writer: a second browser for the same agent would be
    // the same profile opened twice, which Firefox locks against itself.
    const first = await openSession(["pizza.example"]);
    const again = jv(await ctx.sessions.open("int-2", AGENT, ["pizza.example"], false));
    expect(again.get("status").str).toBe("error");
    expect(again.get("error").str).toContain(first);
    expect(jv(await ctx.sessions.command(AGENT, first, { action: "url" })).get("status").str)
      .toBe("completed");
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
    const r = jv(await ctx.sessions.command(AGENT, s, { action: "wait", seconds: 45 }));
    expect(r.get("status").str).toBe("completed");
    expect(r.get("seconds").num).toBe(12); // MAX_WAIT_SECONDS
    const ok = jv(await ctx.sessions.command(AGENT, s, { action: "wait", seconds: 3 }));
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
      const r = jv(await ctx.sessions.command(AGENT, s, { action: "click", selector: "#go", ...extra }));
      expect(r.get("status").str).toBe("completed");
    }
    // The knob belongs to no other action.
    await ctx.sessions.command(AGENT, s, { action: "scroll", timeout_ms: 9000 });

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
    const swallowed = jv(await ctx.sessions.command(AGENT, s, {
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
    const r = jv(await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://evil.example/" }));
    expect(r.get("status").str).toBe("error");
    expect(r.get("error").str).toContain("outside the approved origins");
    expect(eventNames()).toContain("browser_scope_violation");
    // The browser never navigated: current url is still blank.
    const u = jv(await ctx.sessions.command(AGENT, s, { action: "url" }));
    expect(u.get("url").str).toBe("about:blank");
  });

  it("wildcards match subdomains", async () => {
    const s = await openSession(["*.pizza.example", "pizza.example"]);
    const r = jv(
      await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://www.pizza.example/x" }),
    );
    expect(r.get("status").str).toBe("completed");
  });

  it("locks content actions after a click lands out of scope, and strips content from the landing result", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" });
    // Scripted: "#offsite" navigates to https://offsite.example/lander.
    const clicked = jv(await ctx.sessions.command(AGENT, s, { action: "click", selector: "#offsite" }));
    expect(clicked.get("status").str).toBe("completed");
    expect(clicked.get("out_of_scope").str).toBe("offsite.example");

    const text = jv(await ctx.sessions.command(AGENT, s, { action: "text" }));
    expect(text.get("status").str).toBe("error");
    expect(text.get("error").str).toContain("offsite.example");
    const shot = jv(await ctx.sessions.command(AGENT, s, { action: "screenshot" }));
    expect(shot.get("status").str).toBe("error");

    // Way back is allowed.
    const back = jv(
      await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" }),
    );
    expect(back.get("status").str).toBe("completed");
    const text2 = jv(await ctx.sessions.command(AGENT, s, { action: "text" }));
    expect(text2.get("status").str).toBe("completed");
  });

  it("audits popups and allows use_page + extend to reach them", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" });
    await ctx.sessions.command(AGENT, s, { action: "click", selector: "#popup" });
    const navs = ctx.events.filter((e) => e.event === "browser_navigated");
    expect(JSON.stringify(navs)).toContain("popup.example");

    // Switch to the popup: content locked until scope is widened.
    await ctx.sessions.command(AGENT, s, { action: "use_page", index: 1 });
    const locked = jv(await ctx.sessions.command(AGENT, s, { action: "text" }));
    expect(locked.get("status").str).toBe("error");

    const ext = jv(ctx.sessions.extend("int-2", AGENT, s, ["popup.example"], [], false));
    expect(ext.get("status").str).toBe("completed");
    const text = jv(await ctx.sessions.command(AGENT, s, { action: "text" }));
    expect(text.get("status").str).toBe("completed");
    expect(eventNames()).toContain("browser_session_extended");
  });
});

describe("credentials", () => {
  it("no longer answers vault questions — that moved to the vault tool", async () => {
    const s = await openSession(["pizza.example"]);
    const r = jv(await ctx.sessions.command(AGENT, s, { action: "credentials" }));
    expect(r.get("status").str).toBe("error");
  });

  it("fill_secret refuses items not approved for the session", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/login" });
    const r = jv(
      await ctx.sessions.command(AGENT, s, {
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
    ctx.sessions.extend("int-3", AGENT, s, [], ["L1"], false);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/login" });
    const r = jv(
      await ctx.sessions.command(AGENT, s, {
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
    ctx.sessions.extend("int-2", AGENT, s, [], ["L1"], false);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/login" });
    const r = jv(
      await ctx.sessions.command(AGENT, s, {
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
    ctx.sessions.extend("int-2", AGENT, s, [], ["X1"], false);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/login" });
    const r = jv(
      await ctx.sessions.command(AGENT, s, {
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
    ctx.sessions.extend("int-2", AGENT, s, [], ["C1"], false);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/checkout" });
    // Scripted: "#card*" selectors live in a frame on payframe.example.
    const denied = jv(
      await ctx.sessions.command(AGENT, s, {
        action: "fill_secret",
        selector: "#card-number",
        item: "C1",
        field: "number",
      }),
    );
    expect(denied.get("status").str).toBe("error");
    expect(denied.get("error").str).toContain("payframe.example");

    ctx.sessions.extend("int-3", AGENT, s, ["payframe.example"], [], false);
    const ok = jv(
      await ctx.sessions.command(AGENT, s, {
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
    await ctx.sessions.command(AGENT, s, {
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
    const opened = jv(await sessions.open("int-1", AGENT, ["pizza.example"], true));
    const handle = opened.get("session").str!;

    expect(() =>
      sessions.extend("int-2", AGENT, handle, ["paypal.example"], ["L1"], true),
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
    await expect(sessions.open("int-1", AGENT, ["pizza.example"], true)).rejects.toThrow(
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
    const retry = jv(await sessions.open("int-1", AGENT, ["pizza.example"], true));
    expect(retry.get("status").str).toBe("completed");
    const r = jv(
      await sessions.command(AGENT, retry.get("session").str!, {
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
    const sessions = new BrowserSessions(browsers, null, () => {}, 60_000);
    const handle = jv(await sessions.open("int-1", AGENT, ["pizza.example"], true))
      .get("session")
      .str!;
    await expect(sessions.close(handle, "agent")).rejects.toThrow(/audit append failed/);

    const retry = jv(await sessions.open("int-2", AGENT, ["pizza.example"], true));
    expect(retry.get("status").str).toBe("completed");
    const r = jv(
      await sessions.command(AGENT, retry.get("session").str!, {
        action: "goto",
        url: "https://pizza.example/",
      }),
    );
    expect(r.get("status").str).toBe("completed");
    await sessions.closeAll("test");
  });
});

describe("one profile per agent, and never a shared one", () => {
  it("keeps two ids apart when sanitising would fold them together", async () => {
    // "a/b" and "ab" sanitise to the same string. Naming a profile directory
    // that way handed the second agent the first one's cookies and signed-in
    // sessions — the leak this test exists to prevent.
    const pairs = [
      ["a/b", "ab"],
      ["agent 1", "agent1"],
      ["../escape", "escape"],
    ];
    const seen = new Set<string>();
    for (const ids of pairs) {
      for (const id of ids) {
        const r = jv(await ctx.sessions.open(`int-${id}`, id, ["pizza.example"], false));
        expect(r.get("status").str).toBe("completed");
        await ctx.sessions.close(r.get("session").str!, "test");
      }
    }
    for (const dir of fs.readdirSync(path.join(ctx.dir, "profiles"))) seen.add(dir);
    // Six distinct agent ids, six distinct profiles — and none of them escaped
    // the profiles directory.
    expect(seen.size).toBe(6);
    for (const dir of seen) expect(dir).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe("upgrading from the one shared profile", () => {
  it("gives the old profile to the first agent, and a clean one to the next", async () => {
    // Before browsers were per agent there was one profile with every login in
    // it. Leaving it behind would sign the owner out of everything they had
    // signed into, so the first agent to open adopts it.
    const legacy = path.join(ctx.dir, "legacy-profile");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "cookies.sqlite"), "signed in everywhere");
    const withLegacy = new BrowserSessions(
      { ...ctx.browsers, profileDir: path.join(ctx.dir, "upgraded"), legacyProfileDir: legacy },
      null,
      () => {},
      60_000,
    );

    const first = jv(await withLegacy.open("int-1", "first-agent", ["pizza.example"], false));
    expect(first.get("status").str).toBe("completed");
    const dirs = fs.readdirSync(path.join(ctx.dir, "upgraded"));
    expect(dirs.length).toBe(1);
    expect(fs.readFileSync(path.join(ctx.dir, "upgraded", dirs[0], "cookies.sqlite"), "utf8"))
      .toBe("signed in everywhere");
    expect(fs.existsSync(legacy)).toBe(false); // adopted, not copied

    // The next agent starts clean — that is the isolation this is all for.
    const second = jv(await withLegacy.open("int-2", "second-agent", ["pizza.example"], false));
    expect(second.get("status").str).toBe("completed");
    const both = fs.readdirSync(path.join(ctx.dir, "upgraded")).sort();
    expect(both.length).toBe(2);
    const other = both.find((d) => d !== dirs[0])!;
    expect(fs.existsSync(path.join(ctx.dir, "upgraded", other, "cookies.sqlite"))).toBe(false);
    await withLegacy.closeAll("test");
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
        ctx.sessions.open(`int-${i}`, agent, [sites[i]], false).then((r) => jv(r)),
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
        ctx.sessions.command(agents[i], h, { action: "goto", url: `https://${sites[i]}/page` }),
      ),
    );

    // Each reports ITS page — not the last one anybody navigated.
    const urls = await Promise.all(
      handles.map((h, i) => ctx.sessions.command(agents[i], h, { action: "url" }).then((r) => jv(r))),
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
      const still = jv(await ctx.sessions.command(agents[i], handles[i], { action: "url" }));
      expect(still.get("url").str).toBe(`https://${sites[i]}/page`);
    }
  });
});
