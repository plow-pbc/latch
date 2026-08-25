/**
 * The browser tool surface, end to end and in process — the MCP server on the
 * Mac driving a fake browser server + fake vault broker (no Python, no
 * Camoufox). A `Request` goes in, a `Response` comes out; the audit log is the
 * oracle and never holds a secret.
 *
 * The real Camoufox flow is exercised by browser.integration.test.ts (opt-in).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSONValue, jv } from "@domo/protocol";
import { DeviceAgent, HeadlessPolicy, PolicyDelegate, ResolvedBrowserRuntime } from "@domo/device-core";
import { createDomoMcpServer, DomoMcpServer, RelayAuth, TOOLS } from "@domo/mcp-server";
import { callTool, parse, rpc } from "./client.js";

const fixtures = fileURLToPath(new URL("../../../e2e/fixtures", import.meta.url));
const FAKE_SERVER = path.join(fixtures, "fakeBrowserServer.cjs");
const FAKE_BROKER = path.join(fixtures, "fakeVaultBroker.cjs");

const AGENT: RelayAuth = { agent_id: "agent-1", agent_name: "Pizza Agent", scopes: ["relay:call"] };

const cleanups: (() => void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-br-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeVault(dir: string): string {
  const vaultPath = path.join(dir, "vault.json");
  fs.writeFileSync(
    vaultPath,
    JSON.stringify([
      { id: "L1", title: "Pizza Login", category: "LOGIN", username: "jon",
        urls: ["https://pizza.example/"],
        descriptors: [{ label: "password", hidden: true, custom: false, alias: false }, { label: "username", hidden: false, custom: false, alias: false }],
        values: { password: "hunter2", username: "jon" } },
      { id: "C1", title: "Visa", category: "CREDIT_CARD", username: "", urls: [],
        descriptors: [{ label: "number", hidden: true, custom: false, alias: false }, { label: "cvv", hidden: true, custom: false, alias: true }],
        values: { number: "4111111111111111", cvv: "123" } },
    ]),
  );
  return vaultPath;
}

function makeServer(
  delegate: PolicyDelegate = new HeadlessPolicy({ intent: "allow_once" }),
): { server: DomoMcpServer; device: DeviceAgent; fillLog: string; argvLog: string; home: string } {
  const dir = tempDir();
  const fillLog = path.join(dir, "fills.log");
  const argvLog = path.join(dir, "argv.log");
  const runtime: ResolvedBrowserRuntime = {
    serverCommand: ["node", FAKE_SERVER],
    mergeCookiesCommand: [],
    credentialBrokerCommand: ["node", FAKE_BROKER],
    env: {
      FAKE_BROKER_VAULT: writeVault(dir),
      FAKE_FILL_LOG: fillLog,
      FAKE_ARGV_LOG: argvLog,
    },
    camoufoxInstallDir: null,
  };
  const home = path.join(dir, "home");
  const device = new DeviceAgent(home, "Test Mac", delegate, runtime);
  const server = createDomoMcpServer(device);
  cleanups.push(() => server.close());
  cleanups.push(() => device.shutdown());
  return { server, device, fillLog, argvLog, home };
}

/** How each browser launch was spawned, oldest first. */
const launches = (argvLog: string): string[] =>
  fs.readFileSync(argvLog, "utf8").trim().split("\n");

const events = (device: DeviceAgent): string[] =>
  device.audit.entries().map((e) => jv(e as JSONValue).get("event").str ?? "");

async function open(server: DomoMcpServer, origins: string[]): Promise<string> {
  const { payload, isError } = await callTool(server, "plow_browser_open", { origins }, AGENT);
  expect(isError, JSON.stringify(payload)).toBe(false);
  return payload.session as string;
}

const act = (server: DomoMcpServer, session: string, action: string, extra: Record<string, unknown> = {}) =>
  callTool(server, "plow_browser", { session, action, ...extra }, AGENT);

describe("browser tools (fake runtime)", () => {
  it("advertises the browsing skill via plow_list_skills + plow_read_skill", async () => {
    const { server } = makeServer();
    const list = parse(await rpc(server, "tools/call", { name: "plow_list_skills", arguments: {} }, AGENT));
    const skills = JSON.parse(list.result!.content![0].text).skills as { name: string }[];
    expect(skills.map((s) => s.name)).toContain("camoufox-browsing");
    const { payload } = await callTool(server, "plow_read_skill", { name: "camoufox-browsing" }, AGENT);
    expect(payload.body).toContain("fill_secret");
  });

  it("open → browse → screenshot image block → scope lockout → extend → fill_secret → close", async () => {
    const { server, device, fillLog } = makeServer();
    const session = await open(server, ["pizza.example", "*.pizza.example"]);
    expect(session.length).toBeGreaterThan(10);

    const nav = await act(server, session, "goto", { url: "https://pizza.example/menu" });
    expect(nav.payload.url).toBe("https://pizza.example/menu");

    // Screenshot arrives as a real MCP image content block.
    const shot = parse(await rpc(
      server, "tools/call", { name: "plow_browser", arguments: { session, action: "screenshot" } }, AGENT,
    ));
    const blocks = shot.result!.content as { type: string; data?: string; text?: string }[];
    expect(blocks[0].type).toBe("image");
    expect((blocks[0].data ?? "").length).toBeGreaterThan(10);
    expect(blocks[1].type).toBe("text");

    // Out-of-scope goto refused.
    const refused = await act(server, session, "goto", { url: "https://evil.example/" });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.payload)).toContain("outside the approved origins");

    // Popup lands out of scope; content locks until scope widens.
    await act(server, session, "click", { selector: "#popup" });
    await act(server, session, "use_page", { index: 1 });
    expect((await act(server, session, "text")).isError).toBe(true);
    const ext = await callTool(server, "plow_browser_request", { session, origins: ["popup.example"] }, AGENT);
    expect(ext.isError).toBe(false);
    expect((await act(server, session, "text")).isError).toBe(false);

    // The vault answers on its own tool now, with no session involved; filling
    // still needs an approved item inside the session.
    await act(server, session, "use_page", { index: 0 });
    const creds = await callTool(server, "plow_vault", { action: "list" }, AGENT);
    const ids = (creds.payload.items as { id: string }[]).map((i) => i.id);
    // Asked without ever opening a session, which is the point of the split.
    const cold = await callTool(server, "plow_vault", { action: "list" }, AGENT);
    expect((cold.payload.items as unknown[]).length).toBe(ids.length);
    const described = await callTool(server, "plow_vault", { action: "describe", item: "L1" }, AGENT);
    expect(described.payload.fields).toContainEqual({ label: "password", hidden: true, custom: false, alias: false });
    expect(JSON.stringify(described.payload)).not.toContain("hunter2");
    expect(ids).toEqual(expect.arrayContaining(["L1", "C1"]));
    expect(JSON.stringify(creds.payload)).not.toContain("hunter2");

    expect((await act(server, session, "fill_secret", { selector: "#pass", item: "L1", field: "password" })).isError).toBe(true);
    const grant = await callTool(server, "plow_browser_request", { session, credential_items: ["L1"] }, AGENT);
    expect(grant.isError).toBe(false);

    const filled = await act(server, session, "fill_secret", { selector: "#pass", item: "L1", field: "password" });
    expect(filled.isError).toBe(false);
    expect(filled.payload.ok).toBe(true);
    // The secret reached the browser fill but appears in no result and no audit line.
    expect(fs.readFileSync(fillLog, "utf8")).toContain("#pass\thunter2");
    expect(JSON.stringify(filled.payload)).not.toContain("hunter2");

    const closed = await callTool(server, "plow_browser_close", { session }, AGENT);
    expect(closed.payload.closed).toBe(true);

    const names = events(device);
    for (const e of [
      "browser_session_opened", "browser_started", "browser_command", "browser_navigated",
      "browser_scope_violation", "browser_session_extended", "credential_metadata",
      "credential_denied", "credential_filled", "browser_session_closed",
    ]) {
      expect(names, e).toContain(e);
    }
    expect(fs.readFileSync(device.audit.file, "utf8")).not.toContain("hunter2");
  });

  it("an action that failed tells the agent what its own requests did", async () => {
    // End to end, because an error crosses MCP as a string: a refusal not said
    // IN that string is not said at all, and it is usually the reason.
    const { server } = makeServer();
    const session = await open(server, ["pizza.example"]);
    await act(server, session, "goto", { url: "https://pizza.example/" });
    const failed = await act(server, session, "click", { selector: "#refuses" });
    expect(failed.isError).toBe(true);
    const text = JSON.stringify(failed.payload);
    expect(text).toContain("Timeout 3000ms exceeded");
    expect(text).toContain("the page's own requests were refused");
    expect(text).toContain("pizza.example");
    expect(text).not.toContain("api/order");
  });

  it("denyKinds credential blocks fill grants while browsing still works", async () => {
    const { server } = makeServer(new HeadlessPolicy({ intent: "allow_once", denyKinds: ["credential"] }));
    const session = await open(server, ["pizza.example"]);
    expect((await act(server, session, "goto", { url: "https://pizza.example/" })).isError).toBe(false);
    const denied = await callTool(server, "plow_browser_request", { session, credential_items: ["L1"] }, AGENT);
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.payload)).toContain("denied");
  });

  /** Window mode of each session the owner's log recorded, oldest first. */
  const openedHeaded = (device: DeviceAgent): (boolean | null)[] =>
    device.audit
      .entries()
      .filter((e) => jv(e as JSONValue).get("event").str === "browser_session_opened")
      .map((e) => jv(e as JSONValue).get("headed").bool);

  // Two ways a session's window mode is decided — the app default the install
  // ships with, and the per-session `headed` that overrides it either way.
  // Each row opens twice: a session that says nothing, then one that asks for
  // the opposite. `expected` is both, in order, and every oracle must agree.
  it.each([
    // No DOMO_BROWSER_HEADED at all — this is what a packaged install runs.
    ["the shipped default is headless, and a session can ask to be watched", undefined, true, [false, true]],
    ["DOMO_BROWSER_HEADED=1 puts the window back, and a session can still hide", "1", false, [true, false]],
  ])("%s", async (_name, env, override, expected) => {
    vi.stubEnv("DOMO_BROWSER_HEADED", env);
    cleanups.push(() => vi.unstubAllEnvs());
    const { server, device, argvLog } = makeServer();

    const quiet = await callTool(server, "plow_browser_open", { origins: ["pizza.example"] }, AGENT);
    expect(quiet.isError, JSON.stringify(quiet.payload)).toBe(false);
    await callTool(server, "plow_browser_close", { session: quiet.payload.session }, AGENT);
    const asked = await callTool(
      server, "plow_browser_open", { origins: ["pizza.example"], headed: override }, AGENT,
    );

    // What the agent is told, what the browser was actually launched with (the
    // flag only exists on the command line), and what the owner's log records.
    expect([quiet.payload.headed, asked.payload.headed]).toEqual(expected);
    expect(launches(argvLog).map((argv) => argv.includes("--headed"))).toEqual(expected);
    expect(openedHeaded(device)).toEqual(expected);
  });

  // The other half of the window-mode pair above: which profile a session is
  // built on. Both directions of the one line the flag changes, at the only
  // seam that produces an unset seed in production — a typo in the variable
  // name is invisible without this, and a site's block reproducing again
  // looks exactly like the bug the flag exists to rule out.
  it.each([
    ["a session is the owner's own browser, both ways", undefined, true],
    ["DOMO_BROWSER_FRESH_PROFILE=1 cuts both", "1", false],
  ])("%s", async (_name, env, kept) => {
    vi.stubEnv("DOMO_BROWSER_FRESH_PROFILE", env);
    cleanups.push(() => vi.unstubAllEnvs());
    const { server, home } = makeServer();
    const browser = path.join(home, "device/browser");
    const profile = path.join(browser, "profile");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "signed-in-already"), "the owner's");

    const session = await open(server, ["pizza.example"]);
    const profiles = path.join(browser, "profiles");
    const clone = path.join(profiles, fs.readdirSync(profiles)[0]);
    expect(fs.existsSync(path.join(clone, "signed-in-already"))).toBe(kept);

    // The owner's profile holds no cookie store yet, so what the session signs
    // into is copied rather than merged — the branch a first sign-in takes,
    // and the only one this runtime's empty mergeCookiesCommand can reach.
    fs.writeFileSync(path.join(clone, "cookies.sqlite"), "signed in somewhere");
    await callTool(server, "plow_browser_close", { session }, AGENT);
    expect(fs.readdirSync(profile).sort()).toEqual(
      kept ? ["cookies.sqlite", "signed-in-already"] : ["signed-in-already"],
    );
    expect(fs.readdirSync(profiles)).toEqual([]);
  });

  it("fresh_profile reaches the session through the tool, and the session survives it", async () => {
    // The device-level test proves what the reset does; this proves an agent
    // can actually ask for it. The action enum is validated by the SDK before
    // any handler runs, so a missing entry fails here and nowhere else — and
    // the session has to still be usable afterwards, which is the whole point
    // of resetting in place instead of opening another one.
    const { server } = makeServer();
    const session = await open(server, ["pizza.example"]);

    const reset = await act(server, session, "fresh_profile");
    expect(reset.isError, JSON.stringify(reset.payload)).toBe(false);
    expect(reset.payload.session).toBe(session);

    const after = await act(server, session, "goto", { url: "https://pizza.example/" });
    expect(after.isError, JSON.stringify(after.payload)).toBe(false);
  });

  // A reset pays a browser teardown and a cold Camoufox start — the ~30s that
  // plow_browser_open is deferrable to absorb — while every page action answers
  // in milliseconds. Get this wrong and the exchange tears with the reset still
  // running on the Mac, and the agent cannot tell whether its session survived.
  // Not reachable end-to-end here: this runtime starts instantly, so nothing
  // ever exceeds the budget that would mint a handle.
  it.each([
    ["fresh_profile", true],
    ["screenshot", false],
  ])("%s decides deferral on what it was asked to do", (action, expected) => {
    const { deferrable } = TOOLS.find((t) => t.name === "plow_browser")!;
    // Asserted on its own: folded into the row below as `typeof x === "function"
    // && x(...)`, a revert to a plain `false` — the bug this exists to catch —
    // leaves the screenshot row green and only fails the other one.
    expect(typeof deferrable).toBe("function");
    expect((deferrable as (a: JSONValue) => boolean)({ action })).toBe(expected);
  });

  it("a second session is decided entirely by rules — the unattended-pizza oracle", async () => {
    const { server, device } = makeServer(new HeadlessPolicy({ intent: "always_allow" }));
    const runOnce = async () => {
      const session = await open(server, ["pizza.example"]);
      await act(server, session, "goto", { url: "https://pizza.example/" });
      await callTool(server, "plow_browser_request", { session, credential_items: ["L1"] }, AGENT);
      await act(server, session, "fill_secret", { selector: "#pass", item: "L1", field: "password" });
      await callTool(server, "plow_browser_close", { session }, AGENT);
    };
    await runOnce(); // rules stored here
    const before = events(device).filter((e) => e === "intent_decision").length;
    await runOnce(); // must ride rules only
    const decisions = device.audit
      .entries()
      .filter((e) => jv(e as JSONValue).get("event").str === "intent_decision")
      .slice(before);
    expect(decisions.length).toBeGreaterThanOrEqual(2); // open + extend
    for (const d of decisions) expect(jv(d as JSONValue).get("source").str).toBe("rule");
  });
});
