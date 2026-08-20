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
import { createDomoMcpServer, DomoMcpServer, RelayAuth } from "@domo/mcp-server";
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
): { server: DomoMcpServer; device: DeviceAgent; fillLog: string; argvLog: string } {
  const dir = tempDir();
  const fillLog = path.join(dir, "fills.log");
  const argvLog = path.join(dir, "argv.log");
  const runtime: ResolvedBrowserRuntime = {
    serverCommand: ["node", FAKE_SERVER],
    credentialBrokerCommand: ["node", FAKE_BROKER],
    env: {
      FAKE_BROKER_VAULT: writeVault(dir),
      FAKE_FILL_LOG: fillLog,
      FAKE_ARGV_LOG: argvLog,
    },
    camoufoxInstallDir: null,
  };
  const device = new DeviceAgent(path.join(dir, "home"), "Test Mac", delegate, runtime);
  const server = createDomoMcpServer(device);
  cleanups.push(() => server.close());
  cleanups.push(() => device.shutdown());
  return { server, device, fillLog, argvLog };
}

/** How each browser launch was spawned, oldest first. */
const launches = (argvLog: string): string[] =>
  fs.readFileSync(argvLog, "utf8").trim().split("\n");

const events = (device: DeviceAgent): string[] =>
  device.audit.entries().map((e) => jv(e as JSONValue).get("event").str ?? "");

async function open(server: DomoMcpServer, origins: string[], metadata = true): Promise<string> {
  const { payload, isError } = await callTool(
    server,
    "plow_browser_open",
    { origins, credentials_metadata: metadata },
    AGENT,
  );
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

  it("denyKinds credential blocks fill grants while browsing still works", async () => {
    const { server } = makeServer(new HeadlessPolicy({ intent: "allow_once", denyKinds: ["credential"] }));
    const session = await open(server, ["pizza.example"], false);
    expect((await act(server, session, "goto", { url: "https://pizza.example/" })).isError).toBe(false);
    const denied = await callTool(server, "plow_browser_request", { session, credential_items: ["L1"] }, AGENT);
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.payload)).toContain("denied");
  });

  it("the agent picks the window mode per session; saying nothing keeps it visible", async () => {
    vi.stubEnv("DOMO_BROWSER_HEADED", "1"); // the shipped default: visible
    cleanups.push(() => vi.unstubAllEnvs());
    const { server, device, argvLog } = makeServer();

    const hidden = await callTool(
      server, "plow_browser_open", { origins: ["pizza.example"], headed: false }, AGENT,
    );
    expect(hidden.isError, JSON.stringify(hidden.payload)).toBe(false);
    expect(hidden.payload.headed).toBe(false);
    await callTool(server, "plow_browser_close", { session: hidden.payload.session }, AGENT);

    const watched = await callTool(server, "plow_browser_open", { origins: ["pizza.example"] }, AGENT);
    expect(watched.payload.headed).toBe(true);

    // The flag only exists on the command line, so the launches are the oracle.
    const [first, second] = launches(argvLog);
    expect(first).not.toContain("--headed");
    expect(second).toContain("--headed");
    // And the owner's log says which browser each session got.
    const opened = device.audit
      .entries()
      .filter((e) => jv(e as JSONValue).get("event").str === "browser_session_opened")
      .map((e) => jv(e as JSONValue).get("headed").bool);
    expect(opened).toEqual([false, true]);
  });

  it("an origin that bounds nothing never reaches the owner's approval card", async () => {
    const { server, device } = makeServer(new HeadlessPolicy({ intent: "always_allow" }));

    // A list of nothing but unmatchable patterns is refused before the owner
    // is asked to approve a blank bound — and told what is actually wrong,
    // since an agent told its origins were missing resends the same array.
    const blank = await callTool(
      server, "plow_browser_open", { origins: ["   ", "*."] }, AGENT,
    );
    expect(blank.isError).toBe(true);
    expect(JSON.stringify(blank.payload)).toContain("no 'origins' pattern can match a host");
    // The same for a widen, one tool over — including the arm that used to
    // succeed quietly, dropping the origins and widening credentials only.
    for (const extra of [{}, { credential_items: ["L1"] }]) {
      const widen = await callTool(
        server, "plow_browser_request", { session: "whatever", origins: ["*."], ...extra }, AGENT,
      );
      expect(widen.isError, JSON.stringify(widen.payload)).toBe(true);
      expect(JSON.stringify(widen.payload)).toContain("no 'origins' pattern can match a host");
    }
    // An omitted or empty list is the schema's to refuse, not the handler's —
    // asserted here so the handler's silence on it stays justified.
    for (const args of [{}, { origins: [] }]) {
      const absent = await callTool(server, "plow_browser_open", args, AGENT);
      expect(absent.isError, JSON.stringify(absent.payload)).toBe(true);
      expect(JSON.stringify(absent.payload)).toContain("validation");
    }

    // A real origin carrying one alongside it opens, with the junk dropped —
    // the card, the session bound and the profile all name the same set.
    const opened = await callTool(
      server, "plow_browser_open", { origins: ["pizza.example", ""] }, AGENT,
    );
    expect(opened.isError, JSON.stringify(opened.payload)).toBe(false);
    expect(opened.payload.origins).toEqual(["pizza.example"]);
    const bound = device.audit
      .entries()
      .filter((e) => jv(e as JSONValue).get("event").str === "browser_session_opened")
      .map((e) => jv(e as JSONValue).get("origins").value);
    expect(bound.at(-1)).toEqual(["pizza.example"]);

    // What the owner was shown carries no blank either.
    const asked = device.audit
      .entries()
      .filter((e) => jv(e as JSONValue).get("event").str === "intent_received")
      .map((e) => JSON.stringify(jv(e as JSONValue).get("capabilities").value));
    // Pinned at both ends: a leaked blank sorts first and would render
    // "Browse: , pizza.example", which a prefix match happily accepts.
    expect(asked.at(-1)).toContain('"Browse: pizza.example"');

    // And the rule that open saved re-matches the clean list — the failure
    // this is really about: a rule keyed on a bound with a blank in it could
    // never be matched again by a session asking for the same thing.
    await callTool(server, "plow_browser_close", { session: opened.payload.session }, AGENT);
    const again = await callTool(
      server, "plow_browser_open", { origins: ["pizza.example"] }, AGENT,
    );
    expect(again.isError, JSON.stringify(again.payload)).toBe(false);
    const sources = device.audit
      .entries()
      .filter((e) => jv(e as JSONValue).get("event").str === "intent_decision")
      .map((e) => jv(e as JSONValue).get("source").str);
    expect(sources.at(-1)).toBe("rule");
  });

  it("each approved origin set browses in its own profile, and comes back to it", async () => {
    const { server, argvLog } = makeServer(new HeadlessPolicy({ intent: "always_allow" }));

    const runOnce = async (origins: string[]) => {
      const session = await open(server, origins);
      await callTool(server, "plow_browser_close", { session }, AGENT);
    };
    await runOnce(["pizza.example", "*.pizza.example"]);
    await runOnce(["bank.example"]);
    // The same grant, spelled differently: the profile is the set, not the string.
    await runOnce(["*.PIZZA.example", "pizza.example"]);

    const profileOf = (argv: string) => {
      const parts = argv.split(/\s+/);
      const i = parts.indexOf("--profile-dir");
      return i === -1 ? null : parts[i + 1];
    };
    const [pizza, bank, pizzaAgain] = launches(argvLog).map(profileOf);
    expect(pizza).toBeTruthy();
    // The bank session cannot read what the pizza session left behind...
    expect(bank).not.toBe(pizza);
    // ...and pizza is recognized when it comes back.
    expect(pizzaAgain).toBe(pizza);
  });

  it("a second agent racing the cold start is refused, not handed the browser", async () => {
    // plow_browser_open is deferrable and a cold browser takes ~30s, so a
    // second open genuinely arrives while the first is still starting. Run
    // concurrently rather than queued, both callers find no session yet and
    // both pass the in-use guard — and the second agent walks into a browser
    // it was never granted.
    const { server } = makeServer(new HeadlessPolicy({ intent: "always_allow" }));
    const other: RelayAuth = { ...AGENT, agent_id: "agent-2", agent_name: "Bank Agent" };

    const [pizza, bank] = await Promise.all([
      callTool(server, "plow_browser_open", { origins: ["pizza.example"] }, AGENT),
      callTool(server, "plow_browser_open", { origins: ["bank.example"] }, other),
    ]);

    const outcomes = [pizza, bank].map((r) => JSON.stringify(r.payload));
    expect(outcomes.filter((o) => o.includes("in use by another agent"))).toHaveLength(1);
    expect(outcomes.filter((o) => !o.includes("in use by another agent"))).toHaveLength(1);
  });

  it("DOMO_BROWSER_FRESH_PROFILE gives every session a profile with no history", async () => {
    vi.stubEnv("DOMO_BROWSER_FRESH_PROFILE", "1");
    cleanups.push(() => vi.unstubAllEnvs());
    const { server, argvLog } = makeServer();

    const session = await open(server, ["pizza.example"]);
    await callTool(server, "plow_browser_close", { session }, AGENT);

    expect(launches(argvLog)[0]).not.toContain("--profile-dir");
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
