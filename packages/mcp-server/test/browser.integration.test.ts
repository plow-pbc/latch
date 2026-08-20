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
    const attempt = site.state.loginAttempts.at(-1)!;
    expect(attempt).toMatchObject({ user: "jon@example.com", pass: "pizza-time-99" });
    // Issue #86. Both credentials arrived as real typing: one browser-produced
    // character key event per character, in a field the page was watching.
    // `fill()` would have set .value and fired a single input event, and the
    // page — like the defense in front of a real sign-in — would have counted
    // none at all.
    expect(attempt.keys).toBe("jon@example.com".length + "pizza-time-99".length);

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

    // A fill searches every frame, so the outer ones fail first with nothing
    // more interesting than "no such selector here". What comes back has to be
    // the frame that actually held the field and refused.
    const locked = await act("fill", { selector: "#card-locked", value: "x" }, false);
    expect(locked.isError).toBe(true);
    expect(JSON.stringify(locked.payload)).toContain("not editable");

    // Same rule for a frame that HAS the field and will not hand it over: a
    // hidden one times out exactly like a frame that hasn't got it, and only
    // the second of those is worth burying.
    const hidden = await act("fill", { selector: "#card-hidden", value: "x" }, false);
    expect(hidden.isError).toBe(true);
    // The stable half, then the discriminating half: a frame that simply hasn't
    // got the field also times out, but resolves nothing — and the selector's
    // own name appears either way, so it cannot be the discriminator.
    // "resolved to" is Playwright call-log wording; it tracks the pin in
    // runtime.lock.json.
    expect(JSON.stringify(hidden.payload)).toContain("Timeout");
    expect(JSON.stringify(hidden.payload)).toContain("resolved to");

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

  // Issue #88. The claim that cannot be faked and is the whole point: a click
  // Playwright dispatches is trusted, and one synthesized in `eval` is not.
  it("clicks a page a stuck agent would have reached for eval on", async () => {
    const opened = await callTool(
      server, "plow_browser_open",
      { origins: ["127.0.0.1"], headed: false, goal: "get past a modal backdrop" },
      AGENT,
    );
    expect(opened.isError, JSON.stringify(opened.payload)).toBe(false);
    session = opened.payload.session as string;
    const text = async () => (await act("text")).payload.text as string;

    // Three ways a click arrives too early, one row each. The page has four
    // frames and a click's budget covers the whole action, so what is really
    // under test is that the budget goes on watching every frame for the thing
    // to become clickable — not on waiting in each frame in turn, which spends
    // a quarter of it blind to the other three.
    const clearBackdrop = "document.querySelector('.modal-backdrop').remove();";
    const cover = (ms: number) =>
      "const c = document.createElement('div');" +
      "c.style.cssText = 'position:fixed;inset:0';" +
      `document.body.appendChild(c); setTimeout(() => c.remove(), ${ms})`;
    const arrivals = [
      // A cover that clears at 1.2 s — already past the quarter a naive split
      // would give the frame that matters.
      { label: "cover clears at 1.2s", selector: "#continue", timeout: undefined,
        setup: cover(1200) },
      // …and one that clears at 4 s, past the 3 s the tool allowed at all
      // before this change. This is the recovery `timeout_ms` exists for.
      { label: "cover clears at 4s, timeout_ms 6000", selector: "#continue", timeout: 6000,
        setup: cover(4000) },
      // The element itself arriving late, rather than being uncovered.
      { label: "element returns at 1s", selector: "#continue", timeout: undefined,
        setup: "const b = document.getElementById('continue'); b.remove();" +
               "setTimeout(() => document.body.appendChild(b), 1000)" },
    ];
    for (const { label, selector, timeout, setup } of arrivals) {
      await act("goto", { url: site.url + "/blocked" });
      await act("eval", { expression: clearBackdrop + setup });
      await act("click", { selector, ...(timeout === undefined ? {} : { timeout_ms: timeout }) });
      expect(await text(), label).toContain("clicked isTrusted=true");
    }

    // The other side of that: a frame injected while the click waits is NOT
    // eligible. The owner approved origins for the page the device could see,
    // and a page that knows a click is in flight could otherwise race a frame
    // carrying the same selector into the DOM (issue #95). What has to hold is
    // that the frame arrives AFTER the click has taken its list — 2 s in,
    // against a 5 s budget, so neither end of that ordering is marginal.
    await act("goto", { url: site.url + "/blocked" });
    await act("eval", {
      expression:
        clearBackdrop +
        "setTimeout(() => {" +
        "  const f = document.createElement('iframe');" +
        "  f.src = '/late'; document.body.appendChild(f);" +
        "}, 2000)",
    });
    const injected = await act("click", { selector: "#late", timeout_ms: 5000 }, false);
    expect(injected.isError).toBe(true);
    expect(JSON.stringify(injected.payload)).toContain("no frame has #late");
    // …and the same click once the frame is part of the page the command sees.
    // Without this the refusal above would read identically if the injection
    // had never happened at all — a renamed route, a typo, a 404. Note what it
    // pins: the freeze is per COMMAND, so a frame that arrived mid-wait is
    // ordinary on the next one. If #95 ever makes eligibility origin-scoped,
    // this line is expected to change rather than being a contract to defend.
    await act("click", { selector: "#late" });

    await act("goto", { url: site.url + "/blocked" });

    // The shape the Costco log has: visible, enabled, stable — and unclickable.
    // No click gets through a backdrop; the failure names it, which is what the
    // agent needs to know instead of reaching for `eval`.
    const blocked = await act("click", { selector: "#continue", timeout_ms: 1000 }, false);
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.payload)).toContain("intercepts pointer events");
    expect(await text()).toContain("no click yet");

    // The way through: deal with what is in the way, with a real click.
    await act("click", { selector: "#dismiss" });
    await act("click", { selector: "#continue" });
    expect(await text()).toContain("clicked isTrusted=true");

    // And the fallback all of this exists to replace: the page can tell.
    await act("eval", { expression: "document.querySelector('#continue').click()" });
    expect(await text()).toContain("clicked isTrusted=false");

    await callTool(server, "plow_browser_close", { session }, AGENT);
  }, 300_000);
});
