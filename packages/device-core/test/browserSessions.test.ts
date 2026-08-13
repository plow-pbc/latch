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
const FAKE_OP = fileURLToPath(new URL("../../../e2e/fixtures/fakeOpBroker.cjs", import.meta.url));

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
        fields: { password: "hunter2", username: "jon" },
      },
      {
        id: "C1",
        title: "Visa",
        category: "CREDIT_CARD",
        username: "",
        urls: [],
        fields: { number: "4111111111111111", cvv: "123" },
      },
      {
        id: "X1",
        title: "Other Site",
        category: "LOGIN",
        username: "x",
        urls: ["https://elsewhere.example/"],
        fields: { password: "sekret" },
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
    command: ["node", FAKE_OP],
    env: { FAKE_OP_VAULT: vaultPath },
  });
  const sessions = new BrowserSessions(host, credentials, audit, 60_000);
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

describe("credentials", () => {
  it("metadata listing requires the metadata grant", async () => {
    const s = await openSession(["pizza.example"], false);
    const r = jv(await ctx.sessions.command(AGENT, s, { action: "credentials" }));
    expect(r.get("status").str).toBe("error");
    expect(r.get("error").str).toContain("credential metadata was not approved");
  });

  it("lists metadata only — no secret values anywhere", async () => {
    const s = await openSession(["pizza.example"]);
    await ctx.sessions.command(AGENT, s, { action: "goto", url: "https://pizza.example/login" });
    const r = jv(await ctx.sessions.command(AGENT, s, { action: "credentials" }));
    expect(r.get("status").str).toBe("completed");
    const items = r.get("items").arr!;
    expect(items.length).toBe(3);
    expect(jv(items[0]).get("title").str).toBe("Pizza Login");
    expect(jv(items[0]).get("matches_this_page").bool).toBe(true);
    expect(JSON.stringify(items)).not.toContain("hunter2");
    expect(eventNames()).toContain("credential_metadata");
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
    expect(JSON.stringify(denied)).toContain("OpDenied");
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
