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
import { BrowserHost, BrowserSessions, CredentialBroker } from "@domo/device-core";

const FAKE_SERVER = fileURLToPath(
  new URL("../../../e2e/fixtures/fakeBrowserServer.cjs", import.meta.url),
);
const FAKE_BROKER = fileURLToPath(new URL("../../../e2e/fixtures/fakeVaultBroker.cjs", import.meta.url));

interface Ctx {
  sessions: BrowserSessions;
  host: BrowserHost;
  events: { event: string; fields: { [k: string]: JSONValue } }[];
  dir: string;
  fillLog: string;
}

let ctx: Ctx;

function makeCtx(serverEnv: Record<string, string> = {}): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-bs-"));
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
  const host = new BrowserHost({
    command: ["node", FAKE_SERVER],
    env: { FAKE_FILL_LOG: fillLog, ...serverEnv },
    screenshotsDir: path.join(dir, "shots"),
    audit,
  });
  const credentials = new CredentialBroker({
    command: ["node", FAKE_BROKER],
    env: { FAKE_BROKER_VAULT: vaultPath },
  });
  const sessions = new BrowserSessions(host, credentials, audit, 60_000);
  // Wired as DeviceAgent wires it, so a crash closes the books the way it does
  // in production rather than only when a test calls noteCrash by hand.
  host.onCrash = () => sessions.noteCrash();
  return { sessions, host, events, dir, fillLog };
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
    // What DeviceAgent's host.onCrash wiring calls when the browser dies.
    ctx.sessions.noteCrash();
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

  it("a second agent cannot open while a session is active", async () => {
    await openSession(["pizza.example"]);
    const r = jv(await ctx.sessions.open("int-2", "agent-2", ["a.example"], false));
    expect(r.get("status").str).toBe("error");
    expect(r.get("error").str).toContain("in use");
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

describe("requests the site refused", () => {
  it("tells the agent and the owner's log, with the query gone", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" });
    // Scripted: "#blocked" is a click whose XHRs the site answers 429/403.
    const r = jv(await ctx.sessions.command(AGENT, s, { action: "click", selector: "#blocked" }));
    expect(r.get("status").str).toBe("completed");

    const failed = r.get("failed_requests").value as JSONValue[];
    expect(failed[0]).toEqual({
      status: 429,
      method: "POST",
      // The browser strips it too; the device does not take that on trust.
      url: "https://pizza.example/api/order",
      frame_url: "https://pizza.example/",
      bytes: 1180,
      retry_after: "30",
    });
    expect(JSON.stringify(failed)).not.toContain("SECRET");
    // Bounded: a chatty page cannot park the relay's exchange budget.
    expect(failed.length).toBe(5);

    const command = ctx.events.filter((e) => e.event === "browser_command").pop();
    expect(command?.fields.failed_requests).toEqual(failed);
  });

  it("says nothing when the page's requests were answered", async () => {
    const s = await openSession(["pizza.example"]);
    const r = jv(await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" }));
    expect(r.get("failed_requests").value).toBeNull();
    const command = ctx.events.filter((e) => e.event === "browser_command").pop();
    expect(command?.fields.failed_requests).toBeUndefined();
  });

  it("puts what is still in flight in the log when the session ends", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" });
    // The late refusal has no action left to ride out on — the browser answers
    // `quit` with it, which is a reply nobody is waiting for. The last thing the
    // page said is exactly what the owner needs.
    await ctx.sessions.command(AGENT, s, { action: "click", selector: "#blocked" });
    await ctx.sessions.close(s, "agent");
    const closed = ctx.events.filter((e) => e.event === "browser_session_closed").pop();
    expect(closed?.fields.failed_requests).toEqual([
      {
        status: 401, method: "GET",
        url: "https://pizza.example/api/whoami", frame_url: "https://pizza.example/",
      },
    ]);
  });

  it("logs them when the browser dies under the session too", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" });
    await ctx.sessions.command(AGENT, s, { action: "click", selector: "#blocked" });
    expect(await ctx.host.viewFrame()).not.toBeNull();
    // What DeviceAgent's host.onCrash wiring calls: there is no browser left to
    // ask, so what the device already holds is the last of the record.
    ctx.sessions.noteCrash();
    const closed = ctx.events.filter((e) => e.event === "browser_session_closed").pop();
    expect(closed?.fields.reason).toBe("crashed");
    expect(closed?.fields.failed_requests).toEqual([
      {
        status: 401, method: "GET",
        url: "https://pizza.example/api/whoami", frame_url: "https://pizza.example/",
      },
    ]);
  });

  it("keeps what an action saw even when that action failed", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" });
    // Scripted: "#refuses" is the motivating shape — the click fails BECAUSE
    // the site refused its request, so the answer is an error, and a refusal
    // that only rode success replies would be the one nobody ever sees.
    const failed = jv(await ctx.sessions.command(AGENT, s, { action: "click", selector: "#refuses" }));
    expect(failed.get("status").str).toBe("error");
    // On the failing action itself, not the one after it: the refusal IS the
    // reason, and an agent reading only the error would otherwise retry blind.
    const entry = {
      status: 403, method: "POST",
      url: "https://pizza.example/api/submit", frame_url: "https://pizza.example/",
    };
    expect(failed.get("failed_requests").value).toEqual([entry]);
    const command = ctx.events.filter((e) => e.event === "browser_command").pop();
    expect(command?.fields.failed_requests).toEqual([entry]);
  });

  it("reports on a credential fill too, which asks the browser for itself twice", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" });
    await ctx.sessions.extend("int-2", AGENT, s, [], ["L1"], false);
    // Scripted: the page refuses a request while the fill's own locate/fill
    // round-trips are in flight. fill_secret builds its result by hand, so it
    // is the one action that could drop them.
    const filled = jv(await ctx.sessions.command(AGENT, s, {
      action: "fill_secret", selector: "#refused-pass", item: "L1", field: "password",
    }));
    expect(filled.get("status").str).toBe("completed");
    const entry = {
      status: 401, method: "POST",
      url: "https://pizza.example/api/session", frame_url: "https://pizza.example/",
    };
    expect(filled.get("failed_requests").value).toEqual([entry]);
    const command = ctx.events.filter((e) => e.event === "browser_command").pop();
    expect(command?.fields.failed_requests).toEqual([entry]);
  });

  it("survives the owner's viewer poll, which asks the browser on its own account", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" });
    await ctx.sessions.command(AGENT, s, { action: "click", selector: "#blocked" });
    // The viewer polls this ~1/s while a session is live and reads a JPEG off
    // the answer. The refusal that settles late must not be spent on it.
    expect(await ctx.host.viewFrame()).not.toBeNull();
    const shot = jv(await ctx.sessions.command(AGENT, s, { action: "screenshot" }));
    expect(shot.get("failed_requests").value).toEqual([
      {
        status: 401, method: "GET",
        url: "https://pizza.example/api/whoami", frame_url: "https://pizza.example/",
      },
    ]);
  });

  it("does not carry an out-of-scope page's traffic home with the way back", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" });
    // Scripted: "#offsite" leaves the approved origins with a refusal of its
    // own, and another that settles while the session is parked out there.
    await ctx.sessions.command(AGENT, s, { action: "click", selector: "#offsite" });
    const back = jv(await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" }));
    expect(back.get("status").str).toBe("completed");
    // The approved page's own refusal, settling while the session was parked
    // out there, is the one the agent needs — and the only one it gets.
    expect(back.get("failed_requests").value).toEqual([
      {
        status: 401, method: "POST",
        url: "https://pizza.example/api/signin", frame_url: "https://pizza.example/",
      },
    ]);
    // What the unapproved page aimed at the approved origin is that page's
    // business, however approved the target is.
    expect(JSON.stringify(back.value)).not.toContain("probed-by-offsite");
    // Nor on the action after it: the way back empties the ring, it does not
    // defer it.
    const shot = jv(await ctx.sessions.command(AGENT, s, { action: "screenshot" }));
    expect(shot.get("failed_requests").value).toBeNull();
    expect(JSON.stringify([back.value, shot.value])).not.toContain("offsite.example");
    // The owner still sees what that page's requests did.
    expect(JSON.stringify(ctx.events)).toContain("offsite.example/api/late");
  });

  it("gives the agent the page's own refusal — the flagship case", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" });
    // A navigation refused by the site: url and frame_url are the same document,
    // and it is the one the agent asked for.
    const r = jv(await ctx.sessions.command(AGENT, s, { action: "click", selector: "#refused-goto" }));
    expect(r.get("failed_requests").value).toEqual([
      {
        status: 429, method: "GET",
        url: "https://pizza.example/checkout", frame_url: "https://pizza.example/checkout",
        retry_after: "",
      },
    ]);
  });

  it("keeps an unattributable refusal for the owner and not for the agent", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" });
    // A service worker's request has no document behind it. Which document
    // asked is what decides whether the agent may hear about it, so an entry
    // that names none stays with the owner.
    const r = jv(await ctx.sessions.command(AGENT, s, { action: "click", selector: "#unattributed" }));
    expect(r.get("failed_requests").value).toBeNull();
    const command = ctx.events.filter((e) => e.event === "browser_command").pop();
    expect(command?.fields.failed_requests).toEqual([
      { status: 503, method: "GET", url: "https://pizza.example/api/sw", frame_url: "" },
    ]);
  });

  it("hands the agent nothing it cannot read — a malformed list is not passed through", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/" });
    for (const selector of ["#malformed", "#malformed-entries"]) {
      const r = jv(await ctx.sessions.command(AGENT, s, { action: "click", selector }));
      expect(r.get("status").str).toBe("completed");
      expect(r.get("failed_requests").value).toBeNull();
      expect(JSON.stringify(r.value)).not.toContain("SECRET");
    }
    expect(JSON.stringify(ctx.events)).not.toContain("SECRET");
  });

  it("withholds them from the agent off-scope, and keeps them for the owner", async () => {
    const s = await openSession(["pizza.example"]);
    // Scripted: "#offsite" lands off-scope having had a request refused. The
    // agent is told nothing about that page; the owner's log still is.
    const gone = jv(await ctx.sessions.command(AGENT, s, { action: "click", selector: "#offsite" }));
    expect(gone.get("out_of_scope").str).toBe("offsite.example");
    expect(gone.get("failed_requests").value).toBeNull();
    const command = ctx.events.filter((e) => e.event === "browser_command").pop();
    expect(command?.fields.failed_requests).toEqual([
      {
        status: 403, method: "GET",
        url: "https://offsite.example/api/who", frame_url: "https://offsite.example/lander",
      },
    ]);
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
      ctx.host,
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
    expect(ctx.host.running).toBe(false);

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
    const host = new BrowserHost({
      command: ["node", FAKE_SERVER],
      env: {},
      screenshotsDir: path.join(ctx.dir, "shots2"),
      audit: (event: string) => {
        if (event === "browser_stopped" && !fired) {
          fired = true;
          throw new Error("audit append failed");
        }
      },
    });
    const sessions = new BrowserSessions(host, null, () => {}, 60_000);
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
    await host.shutdown();
  });
});
