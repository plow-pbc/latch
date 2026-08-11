/**
 * The browser tool surface, end to end and in process — the MCP server on the
 * Mac driving a fake browser server + fake 1Password broker (no Python, no
 * Camoufox). A `Request` goes in, a `Response` comes out; the audit log is the
 * oracle and never holds a secret.
 *
 * The real Camoufox flow is exercised by browser.integration.test.ts (opt-in).
 */
import { afterEach, describe, expect, it } from "vitest";
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
const FAKE_OP = path.join(fixtures, "fakeOpBroker.cjs");

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
        urls: ["https://pizza.example/"], fields: { password: "hunter2", username: "jon" } },
      { id: "C1", title: "Visa", category: "CREDIT_CARD", username: "", urls: [],
        fields: { number: "4111111111111111", cvv: "123" } },
    ]),
  );
  return vaultPath;
}

function makeServer(
  delegate: PolicyDelegate = new HeadlessPolicy({ intent: "allow_once" }),
): { server: DomoMcpServer; device: DeviceAgent; fillLog: string } {
  const dir = tempDir();
  const fillLog = path.join(dir, "fills.log");
  const runtime: ResolvedBrowserRuntime = {
    serverCommand: ["node", FAKE_SERVER],
    opBrokerCommand: ["node", FAKE_OP],
    env: { FAKE_OP_VAULT: writeVault(dir), FAKE_FILL_LOG: fillLog },
    camoufoxInstallDir: null,
  };
  const device = new DeviceAgent(path.join(dir, "home"), "Test Mac", delegate, undefined, runtime);
  const server = createDomoMcpServer(device);
  cleanups.push(() => server.close());
  cleanups.push(() => device.shutdown());
  return { server, device, fillLog };
}

const events = (device: DeviceAgent): string[] =>
  device.audit.entries().map((e) => jv(e as JSONValue).get("event").str ?? "");

async function open(server: DomoMcpServer, origins: string[], metadata = true): Promise<string> {
  const { payload, isError } = await callTool(
    server,
    "browser_open",
    { origins, credentials_metadata: metadata },
    AGENT,
  );
  expect(isError, JSON.stringify(payload)).toBe(false);
  return payload.session as string;
}

const act = (server: DomoMcpServer, session: string, action: string, extra: Record<string, unknown> = {}) =>
  callTool(server, "browser", { session, action, ...extra }, AGENT);

describe("browser tools (fake runtime)", () => {
  it("advertises the browsing skill via list_tools + read_skill", async () => {
    const { server } = makeServer();
    const list = parse(await rpc(server, "tools/call", { name: "list_tools", arguments: {} }, AGENT));
    const skills = JSON.parse(list.result!.content![0].text).skills as { name: string }[];
    expect(skills.map((s) => s.name)).toContain("camoufox-browsing");
    const { payload } = await callTool(server, "read_skill", { name: "camoufox-browsing" }, AGENT);
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
      server, "tools/call", { name: "browser", arguments: { session, action: "screenshot" } }, AGENT,
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
    const ext = await callTool(server, "browser_request", { session, origins: ["popup.example"] }, AGENT);
    expect(ext.isError).toBe(false);
    expect((await act(server, session, "text")).isError).toBe(false);

    // Credentials: metadata lists ids, no values; fill needs an approved item.
    await act(server, session, "use_page", { index: 0 });
    const creds = await act(server, session, "credentials");
    const ids = (creds.payload.items as { id: string }[]).map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(["L1", "C1"]));
    expect(JSON.stringify(creds.payload)).not.toContain("hunter2");

    expect((await act(server, session, "fill_secret", { selector: "#pass", item: "L1", field: "password" })).isError).toBe(true);
    const grant = await callTool(server, "browser_request", { session, credential_items: ["L1"] }, AGENT);
    expect(grant.isError).toBe(false);

    const filled = await act(server, session, "fill_secret", { selector: "#pass", item: "L1", field: "password" });
    expect(filled.isError).toBe(false);
    expect(filled.payload.ok).toBe(true);
    // The secret reached the browser fill but appears in no result and no audit line.
    expect(fs.readFileSync(fillLog, "utf8")).toContain("#pass\thunter2");
    expect(JSON.stringify(filled.payload)).not.toContain("hunter2");

    const closed = await callTool(server, "browser_close", { session }, AGENT);
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
    const denied = await callTool(server, "browser_request", { session, credential_items: ["L1"] }, AGENT);
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.payload)).toContain("denied");
  });

  it("a second session is decided entirely by rules — the unattended-pizza oracle", async () => {
    const { server, device } = makeServer(new HeadlessPolicy({ intent: "always_allow" }));
    const runOnce = async () => {
      const session = await open(server, ["pizza.example"]);
      await act(server, session, "goto", { url: "https://pizza.example/" });
      await callTool(server, "browser_request", { session, credential_items: ["L1"] }, AGENT);
      await act(server, session, "fill_secret", { selector: "#pass", item: "L1", field: "password" });
      await callTool(server, "browser_close", { session }, AGENT);
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
