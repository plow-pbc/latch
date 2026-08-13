/**
 * The heavy tier: REAL Python runtime + REAL Camoufox driving a local
 * pizza-checkout fixture site through the whole MCP server, with a fake
 * credential broker standing in for the bundled seed_vault_broker.
 *
 * Opt-in: skipped unless DOMO_BROWSER_RUNTIME and DOMO_CAMOUFOX are set (run via
 * `just test-browser` after `just fetch-browser-runtime fetch-browser`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeviceAgent, HeadlessPolicy, resolveBrowserRuntime } from "@domo/device-core";
import { createDomoMcpServer, DomoMcpServer, RelayAuth } from "@domo/mcp-server";
import { callTool, parse, rpc } from "./client.js";
import { createPizzaSite, PizzaSite } from "../../../e2e/fixtures/pizzaSite.js";

const fixtures = fileURLToPath(new URL("../../../e2e/fixtures", import.meta.url));
const AGENT: RelayAuth = { agent_id: "agent-1", agent_name: "Pizza Agent", scopes: ["relay:call"] };
const enabled = !!process.env.DOMO_BROWSER_RUNTIME && !!process.env.DOMO_CAMOUFOX;

describe.skipIf(!enabled)("Integration — real Camoufox orders a pizza", () => {
  let site: PizzaSite;
  let device: DeviceAgent;
  let server: DomoMcpServer;
  let session = "";

  beforeAll(async () => {
    site = await createPizzaSite();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dbi-${crypto.randomBytes(3).toString("hex")}`));
    const vaultPath = path.join(dir, "vault.json");
    fs.writeFileSync(
      vaultPath,
      JSON.stringify([
        { id: "L1", title: "Slice of Test", category: "LOGIN", additional_information: "jon@example.com",
          urls: [{ href: `http://127.0.0.1:${site.port}/`, primary: true }],
          fields: [{ label: "username", value: "jon@example.com" },
                   { label: "password", value: "pizza-time-99", type: "CONCEALED" }] },
        { id: "C1", title: "Visa", category: "CREDIT_CARD", additional_information: "", urls: [],
          fields: [{ label: "number", value: "4111111111111111", type: "CONCEALED" },
                   { label: "cvv", value: "123", type: "CONCEALED" }] },
        { id: "X1", title: "Elsewhere", category: "LOGIN", additional_information: "x",
          urls: [{ href: "https://elsewhere.example/" }],
          fields: [{ label: "password", value: "do-not-release", type: "CONCEALED" }] },
      ]),
    );

    const base = resolveBrowserRuntime()!;
    const runtime = {
      ...base,
      // The broker now ships inside the app and is run by absolute path, so a
      // PATH shim can no longer stand in for it — name the fake outright, or
      // this test would read the real vault.
      credentialBrokerCommand: [path.join(fixtures, "fake-broker", "seed-vault-broker")],
      env: { ...base.env, FAKE_BROKER_VAULT: vaultPath },
    };
    device = new DeviceAgent(path.join(dir, "home"), "Test Mac", new HeadlessPolicy({ intent: "always_allow" }), undefined, runtime);
    server = createDomoMcpServer(device);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await device?.shutdown();
    await site?.close();
  });

  const act = async (action: string, extra: Record<string, unknown> = {}, expectOk = true) => {
    const r = await callTool(server, "browser", { session, action, ...extra }, AGENT);
    if (expectOk) expect(r.isError, `${action}: ${JSON.stringify(r.payload)}`).toBe(false);
    return r;
  };

  it("logs in, orders, pays in the iframe, confirms — secrets never cross MCP", async () => {
    const opened = await callTool(
      server, "browser_open",
      { origins: ["127.0.0.1"], credentials_metadata: true, goal: "order a pizza on the test site" },
      AGENT,
    );
    expect(opened.isError, JSON.stringify(opened.payload)).toBe(false);
    session = opened.payload.session as string;

    await act("goto", { url: site.url + "/" });

    // The vault answers on its own tool, with no session involved.
    const creds = await callTool(server, "vault", { action: "list" }, AGENT);
    const login = (creds.payload.items as { id: string }[]).find((i) => i.id === "L1")!;
    expect(login).toBeTruthy();
    expect(JSON.stringify(creds.payload)).not.toContain("pizza-time-99");

    const described = await callTool(server, "vault", { action: "describe", item: "L1" }, AGENT);
    expect(described.payload.fields).toContain("password");

    await callTool(server, "browser_request", { session, credential_items: ["L1", "C1", "X1"], goal: "log in and pay" }, AGENT);

    await act("fill", { selector: "#user", value: "jon@example.com" });
    await act("fill_secret", { selector: "#pass", item: "L1", field: "password" });
    await act("click", { selector: "#login" });
    expect((await act("text")).payload.text).toContain("Menu");
    expect(site.state.loginAttempts.at(-1)).toEqual({ user: "jon@example.com", pass: "pizza-time-99" });

    await act("click", { selector: "#pepperoni" });
    await act("click", { selector: "#order" });
    const forms = await act("forms");
    const cardField = (forms.payload.forms as { id: string; frame: number }[]).find((f) => f.id === "card-number");
    expect(cardField, "card field visible across frames").toBeTruthy();
    expect(cardField!.frame).toBeGreaterThan(0);

    // An item bound to another site is refused by the REAL origin check.
    const refused = await act("fill_secret", { selector: "#card-number", item: "X1", field: "password" }, false);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.payload)).toContain("refused");

    await act("fill_secret", { selector: "#card-number", item: "C1", field: "number" });
    await act("fill_secret", { selector: "#card-cvv", item: "C1", field: "cvv" });
    await act("click", { selector: "#pay" });
    expect((await act("text")).payload.text).toContain("Order confirmed");
    expect(site.state.orders.at(-1)).toMatchObject({ pizza: "pepperoni", cardNumber: "4111111111111111", cvv: "123" });

    // A real screenshot arrives as an image block.
    const shot = parse(await rpc(server, "tools/call", { name: "browser", arguments: { session, action: "screenshot" } }, AGENT));
    const blocks = shot.result!.content as { type: string; data?: string }[];
    expect(blocks[0].type).toBe("image");
    expect(Buffer.from(blocks[0].data ?? "", "base64").length).toBeGreaterThan(5000);

    // The owner's viewer gets a real frame over the direct host path…
    const frame = await device.browserViewFrame();
    expect(frame).not.toBeNull();
    expect(frame!.mime).toBe("image/jpeg");
    expect(Buffer.from(frame!.dataB64, "base64").length).toBeGreaterThan(5000);

    await callTool(server, "browser_close", { session }, AGENT);

    // …and never resurrects a browser the session close shut down.
    expect(await device.browserViewFrame()).toBeNull();

    const auditRaw = fs.readFileSync(device.audit.file, "utf8");
    for (const e of ["browser_session_opened", "credential_metadata", "credential_filled", "credential_denied", "browser_session_closed"]) {
      expect(auditRaw).toContain(e);
    }
    expect(auditRaw).not.toContain("pizza-time-99");
    expect(auditRaw).not.toContain("4111111111111111");
    const opAudit = fs.readFileSync(path.join(device.home, "device/browser/credential-audit.log"), "utf8");
    expect(opAudit).toContain("RELEASED");
    expect(opAudit).not.toContain("pizza-time-99");
  }, 300_000);
});
