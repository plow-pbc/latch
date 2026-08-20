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
        { id: "L1", title: "Slice of Test", category: "LOGIN", username: "jon@example.com",
          urls: [`http://127.0.0.1:${site.port}/`],
          descriptors: [{ label: "username", hidden: false, custom: false, alias: false }, { label: "password", hidden: true, custom: false, alias: false }],
          values: { username: "jon@example.com", password: "pizza-time-99" } },
        { id: "C1", title: "Visa", category: "CREDIT_CARD", username: "", urls: [],
          descriptors: [{ label: "number", hidden: true, custom: false, alias: false }, { label: "cvv", hidden: true, custom: false, alias: true }],
          values: { number: "4111111111111111", cvv: "123" } },
        { id: "X1", title: "Elsewhere", category: "LOGIN", username: "x",
          urls: ["https://elsewhere.example/"],
          descriptors: [{ label: "password", hidden: true, custom: false, alias: false }],
          values: { password: "do-not-release" } },
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
    device = new DeviceAgent(path.join(dir, "home"), "Test Mac", new HeadlessPolicy({ intent: "always_allow" }), runtime);
    server = createDomoMcpServer(device);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await device?.shutdown();
    await site?.close();
  });

  const act = async (action: string, extra: Record<string, unknown> = {}, expectOk = true) => {
    const r = await callTool(server, "plow_browser", { session, action, ...extra }, AGENT);
    if (expectOk) expect(r.isError, `${action}: ${JSON.stringify(r.payload)}`).toBe(false);
    return r;
  };

  it("logs in, orders, pays in the iframe, confirms — secrets never cross MCP", async () => {
    const opened = await callTool(
      server, "plow_browser_open",
      { origins: ["127.0.0.1"], credentials_metadata: true, goal: "order a pizza on the test site" },
      AGENT,
    );
    expect(opened.isError, JSON.stringify(opened.payload)).toBe(false);
    session = opened.payload.session as string;

    await act("goto", { url: site.url + "/" });

    // The vault answers on its own tool, with no session involved.
    const creds = await callTool(server, "plow_vault", { action: "list" }, AGENT);
    const login = (creds.payload.items as { id: string }[]).find((i) => i.id === "L1")!;
    expect(login).toBeTruthy();
    expect(JSON.stringify(creds.payload)).not.toContain("pizza-time-99");

    const described = await callTool(server, "plow_vault", { action: "describe", item: "L1" }, AGENT);
    expect(described.payload.fields).toContainEqual({ label: "password", hidden: true, custom: false, alias: false });

    await callTool(server, "plow_browser_request", { session, credential_items: ["L1", "C1", "X1"], goal: "log in and pay" }, AGENT);

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
    const shot = parse(await rpc(server, "tools/call", { name: "plow_browser", arguments: { session, action: "screenshot" } }, AGENT));
    const blocks = shot.result!.content as { type: string; data?: string }[];
    expect(blocks[0].type).toBe("image");
    expect(Buffer.from(blocks[0].data ?? "", "base64").length).toBeGreaterThan(5000);

    // The owner's viewer gets a real frame over the direct host path…
    const frame = await device.browserViewFrame();
    expect(frame).not.toBeNull();
    expect(frame!.mime).toBe("image/jpeg");
    expect(Buffer.from(frame!.dataB64, "base64").length).toBeGreaterThan(5000);

    await callTool(server, "plow_browser_close", { session }, AGENT);

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

  it("a login survives inside its grant and is invisible to the next one", async () => {
    // The claim the per-grant profile store rests on, against the real browser
    // and a real Set-Cookie rather than the argv a fake server would echo back.
    // Both grants can reach the site; they differ only in what else the owner
    // approved, which is enough to make them different grants.
    const browseAs = async (origins: string[], run: () => Promise<void>) => {
      const opened = await callTool(
        server, "plow_browser_open", { origins, headed: false }, AGENT,
      );
      expect(opened.isError, JSON.stringify(opened.payload)).toBe(false);
      session = opened.payload.session as string;
      let closed;
      try {
        await run();
      } finally {
        closed = await callTool(server, "plow_browser_close", { session }, AGENT);
      }
      // Asserted after the try, not inside it: a block that failed because the
      // browser died would also fail to close, and throwing here would bury
      // the assertion that actually explains what went wrong.
      expect(closed.isError, JSON.stringify(closed.payload)).toBe(false);
    };
    // /menu serves the menu to whoever holds the cookie and bounces everyone
    // else to the login page. Both outcomes are asserted positively: "not the
    // menu" would also be satisfied by a blank page or a fixture that renamed
    // its heading, neither of which says anything about a cookie jar.
    const menuPageText = async () => {
      await act("goto", { url: site.url + "/menu" });
      return (await act("text")).payload.text as string;
    };
    const SIGNED_IN = /Menu/;
    const SIGNED_OUT = /Log in/;

    await browseAs(["127.0.0.1", "pepperoni.example"], async () => {
      // Cold, before anything is proven about persistence — without this the
      // assertion below would also pass on a profile some other test signed in.
      expect(await menuPageText()).toMatch(SIGNED_OUT);
      await act("goto", { url: site.url + "/" });
      await act("fill", { selector: "#user", value: "jon@example.com" });
      await act("fill", { selector: "#pass", value: "pizza-time-99" });
      await act("click", { selector: "#login" });
      expect(await menuPageText()).toMatch(SIGNED_IN);
    });

    // Same grant, new session, no login: the cookie jar came back.
    await browseAs(["127.0.0.1", "pepperoni.example"], async () => {
      expect(await menuPageText()).toMatch(SIGNED_IN);
    });

    // A different grant on the same site starts from nothing.
    await browseAs(["127.0.0.1", "margherita.example"], async () => {
      expect(await menuPageText()).toMatch(SIGNED_OUT);
    });

    // And the first grant still has its own. Without this the whole test also
    // passes on an implementation that keeps ONE profile and wipes it whenever
    // the grant changes — which is cross-grant isolation bought by forgetting
    // everything, not the store this is meant to describe.
    await browseAs(["127.0.0.1", "pepperoni.example"], async () => {
      expect(await menuPageText()).toMatch(SIGNED_IN);
    });
  }, 300_000);

  it("keeps writing to its jar after a widening, and the widened grant finds it", async () => {
    // Widening moves the live profile directory so the jar stops answering to
    // the key it opened under. Firefox keeps writing the cookie db through its
    // open fds, but anything it creates by path under the old name does not
    // exist any more — so the claim is only worth what a real browser does
    // after the move, which no fake runtime can tell us.
    // An origin set no other test in this file uses, so the jar cannot start
    // out holding somebody else's sid — the fixture keeps every session it
    // ever issued valid, so a borrowed cookie would satisfy every assertion
    // below without a single post-rename byte reaching disk.
    const narrow = ["127.0.0.1", "widen-only.example"];
    const wide = [...narrow, "late.example"];
    const openOn = async (origins: string[]) => {
      const r = await callTool(server, "plow_browser_open", { origins, headed: false }, AGENT);
      expect(r.isError, JSON.stringify(r.payload)).toBe(false);
      session = r.payload.session as string;
    };
    const menu = async () => {
      await act("goto", { url: site.url + "/menu" });
      return (await act("text")).payload.text as string;
    };

    await openOn(narrow);
    await act("goto", { url: site.url + "/" });

    // Widen FIRST, so every cookie in this session is written after it. This
    // is the assertion that refuted the rename this replaced: a real Camoufox
    // went on serving pages after its profile directory moved, but none of
    // the cookies written afterwards reached disk.
    const widened = await callTool(
      server, "plow_browser_request", { session, origins: ["late.example"] }, AGENT,
    );
    expect(widened.isError, JSON.stringify(widened.payload)).toBe(false);
    expect(await menu()).toMatch(/Log in/); // nothing carried in

    // The browser is still usable, and this Set-Cookie lands post-rename.
    await act("goto", { url: site.url + "/" });
    await act("fill", { selector: "#user", value: "jon@example.com" });
    await act("fill", { selector: "#pass", value: "pizza-time-99" });
    await act("click", { selector: "#login" });
    expect(await menu()).toMatch(/Menu/);
    await callTool(server, "plow_browser_close", { session }, AGENT);

    // The widened grant finds that cookie, and it is the only one there was —
    // so the write went into the jar the move took with it, not to the name
    // that stopped existing.
    await openOn(wide);
    expect(await menu()).toMatch(/Menu/);
    await callTool(server, "plow_browser_close", { session }, AGENT);
  }, 300_000);
});
