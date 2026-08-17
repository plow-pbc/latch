// Drive the REAL app through the REAL first run, the way a person does.
//
// This is the harness the dead-panel bug demanded. Read
// `docs/TESTING-THE-APP.md` for how to use it and how to write another.
//
// What makes it evidence rather than decoration:
//
//   - It runs the app's own `main.js`. Not a copy of the wiring, not stubbed
//     `ipcMain` handlers — the actual main process, so a bug that lives in an
//     IPC handler is in scope. The bug that shipped lived in exactly there, and
//     every harness that stubbed the handlers was green while the app was dead.
//   - Every input goes through `webContents.sendInputEvent`: the keyDown/char/
//     keyUp triple for typing, and mouseDown/mouseUp at hit-tested coordinates
//     for clicking. Setting `.value`, calling `.click()`, `.focus()` or
//     dispatching a synthetic Event are BANNED here — they reach in below the
//     layer that breaks, which is why they passed on a panel nobody could use.
//   - Assertions are on what the APP did: the request that reached the server,
//     the state it now holds, the screen it advanced to. Never on the value we
//     just wrote.
//
// It drives the whole flow, not one screen — activation, the text arriving,
// connecting, typing an agent name, clicking Create Agent, the config coming
// back. Every bug of the last two days lived in a seam between screens.
//
//   just first-run-drive
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dir, "../../..");
const outDir = process.env.OUT_DIR ?? "/tmp";

const DISPLAY_CODE = "Z1SWY";
const SEND_TO = "+15559998888";
const SESSION_TOKEN = "plow_SESSION_from_activation";
const DEVICE_TOKEN = "plow_DEVICEcredential_from_login";
// The stand-in Plow still serves `POST /v1/relay/agents` — the endpoint did not
// move, only the screen that calls it. Nothing in this run drives it now that
// the wizard ends at Continue; Chunk 2 drives it from the main window.
const AGENT_TOKEN = "plow_AGENTcredential_shown_once";
/** `PROTOCOL_REVISION` from @domo/mcp-server — the server rejects a call that
 *  does not name one, so the harness must speak it like any real client. */
const MCP_PROTOCOL = "2026-07-28";

let failures = 0;
const check = (what, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "CHECK ok  " : "CHECK FAIL"} ${what}${detail === undefined ? "" : ` — ${detail}`}`);
};
const say = (what) => console.log(`----      ${what}`);

// MARK: a stand-in Plow, on ONE origin — HTTP and the device socket together,
// because that is what the app derives and dials.

/** Flipped when the "user" texts the code. */
let activationCompleted = false;
let tokenHandedOut = false;
const seen = { activate: 0, redeem: 0, devices: 0, agents: 0, info: 0 };
let devicesBody = null;
let agentsBody = null;

const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/v1/auth/activate") {
      seen.activate += 1;
      return json(200, {
        display_code: DISPLAY_CODE,
        activation_secret: "activation_secret_1",
        send_to: SEND_TO,
      });
    }
    if (url.pathname === "/v1/auth/activate/redeem") {
      seen.redeem += 1;
      if (!activationCompleted) return json(200, { status: "pending" });
      if (tokenHandedOut) return json(200, { status: "verified" }); // token omitted
      tokenHandedOut = true;
      return json(200, { status: "verified", token: SESSION_TOKEN });
    }
    if (url.pathname === "/v1/relay/info") {
      seen.info += 1;
      return json(200, {
        uid: "u_drive",
        mcp_url: `http://127.0.0.1:${apiPort}/v1/relay/devices/u_drive/mcp`,
        device_connected: false,
      });
    }
    if (url.pathname === "/v1/relay/devices" && req.method === "POST") {
      seen.devices += 1;
      devicesBody = JSON.parse(body);
      return json(200, { token: DEVICE_TOKEN, key_prefix: DEVICE_TOKEN.slice(5, 13), name: devicesBody.name });
    }
    if (url.pathname === "/v1/relay/agents") {
      seen.agents += 1;
      agentsBody = JSON.parse(body);
      return json(200, { token: AGENT_TOKEN, key_prefix: AGENT_TOKEN.slice(5, 13), name: agentsBody.name });
    }
    return json(404, { detail: "not found" });
  });
});
let apiPort = 0;
let API_BASE = "";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "drive-"));
let relay = null;
let win = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a window by title fragment — approval dialogs open on demand. */
async function waitForWindow(fragment, ms = 20_000) {
  for (let i = 0; i < ms / 100; i += 1) {
    const found = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes(fragment));
    if (found && !found.webContents.isLoading()) return found;
    await sleep(100);
  }
  return null;
}

/** The Set Up window, found the way anything outside the app would find it. */
async function setupWindow() {
  for (let i = 0; i < 100; i += 1) {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes("Set Up"));
    if (win && !win.webContents.isLoading()) return win;
    await sleep(100);
  }
  throw new Error("the Set Up window never appeared");
}

/** Every window the app currently has, by title. The gate is a claim about
 *  this list and nothing else, so it is what the gate checks assert on. */
const windowTitles = () =>
  BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed())
    .map((w) => w.getTitle())
    .sort();

/** Wait until the window list matches — window teardown and creation are not
 *  instant, and a gate check racing them would be a coin flip. */
async function waitForWindows(predicate, ms = 10_000) {
  for (let i = 0; i < ms / 100; i += 1) {
    if (predicate(windowTitles())) return true;
    await sleep(100);
  }
  return false;
}

const onlySetup = (titles) => titles.length === 1 && titles[0].includes("Set Up");
const onlyMain = (titles) => titles.length === 1 && titles[0].includes("Domo Desktop");

const js = (src) => win.webContents.executeJavaScript(src);

/** Hit-test: the centre of the element, and what actually sits on top there. */
async function locate(selector) {
  return js(`
    (() => {
      const el = ${selector};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      const top = document.elementFromPoint(x, y);
      return { x, y, reachable: top === el || el.contains(top),
               onTop: top ? top.tagName + "." + top.className : null };
    })()
  `);
}

/** A real click, at real coordinates. */
async function click(where) {
  win.webContents.sendInputEvent({ type: "mouseDown", ...where, button: "left", clickCount: 1 });
  await sleep(40);
  win.webContents.sendInputEvent({ type: "mouseUp", ...where, button: "left", clickCount: 1 });
  await sleep(200);
}

/** Real keystrokes, one triple per character. Unused while the wizard has no
 *  text field of its own; the Connect-a-client screen brings one back. */
async function type(text) {
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: ch });
    win.webContents.sendInputEvent({ type: "char", keyCode: ch });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: ch });
    await sleep(15);
  }
  await sleep(250);
}

const bodyText = () => js("document.body.innerText");
const waitForText = async (needle, ms = 20_000) => {
  for (let i = 0; i < ms / 100; i += 1) {
    if ((await bodyText()).includes(needle)) return true;
    await sleep(100);
  }
  return false;
};
/** Capture a window — the setup window by default, since that is what most of
 *  this run drives. The gate hands over to another one, so it is a parameter. */
const shot = async (name, target = null) => {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `drive-${name}.png`);
  fs.writeFileSync(file, (await (target ?? win).webContents.capturePage()).toPNG());
  console.log(`SHOT: ${file}`);
};

async function main() {
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  apiPort = api.address().port;
  API_BASE = `http://127.0.0.1:${apiPort}`;

  // The device socket, on that same origin — `relaySocketUrl` swaps the scheme
  // and appends the relay path, so it must be served here, not on its own port.
  const { FakeRelay } = await import(
    path.join(repoRoot, "packages/relay-client/dist-test/fakeRelay.js")
  );
  relay = await FakeRelay.start({ expectCredential: DEVICE_TOKEN, server: api });

  // Point the real app at it, from a clean home. Both must be set before the
  // app's main.js is imported — it reads them as it loads.
  process.env.DOMO_HOME = home;
  process.env.DOMO_API_BASE_URL = API_BASE;
  say(`clean DOMO_HOME ${home}`);
  say(`stand-in Plow (HTTP + device socket) ${API_BASE}`);

  // The app's own main process. Everything below drives what this creates.
  await import(path.join(dir, "../dist/main.js"));

  win = await setupWindow();
  // macOS gives key focus only to the frontmost app, and an unfocused window
  // swallows sendInputEvent exactly as it would swallow a real keyboard.
  app.focus({ steal: true });
  win.show();
  win.focus();
  win.webContents.focus();
  await sleep(800);

  try {
    // 1. The window must hold still. This is the dead-panel bug itself, measured
    //    rather than inferred: a tree being rebuilt cannot be typed into, because
    //    focus does not survive and a click needs mousedown and mouseup on one
    //    element. Everything after this check depends on it.
    say("first run opens on the activation screen");
    check("the app opened the Set Up window by itself", true);
    // THE GATE (a): a Mac with no credential gets the setup window and nothing
    // else. Not "the main window with a setup window in front of it" — the main
    // window must not exist, because nothing in it would work.
    check(
      "no main window exists on a Mac that is not signed in",
      onlySetup(windowTitles()),
      JSON.stringify(windowTitles()),
    );
    await js(`
      window.__churn = 0;
      new MutationObserver(() => { window.__churn++; })
        .observe(document.getElementById("root"), { childList: true, subtree: true });
    `);
    await sleep(1500);
    const churn = await js("window.__churn");
    check("the DOM is not rebuilding itself while idle", churn === 0, `${churn} mutations in 1.5s`);

    // 2. Nothing may be sitting inside a drag region: elements inside one are
    //    inert in Electron and it presents exactly like the bug above.
    const inDrag = await js(`
      [...document.querySelectorAll("input, button")].filter((el) => {
        for (let n = el; n; n = n.parentElement) {
          const region = getComputedStyle(n).webkitAppRegion;
            if (region === "drag") return true;
            // Not inherited: the NEAREST declaration wins. Walking up for any
            // drag would flag the main window's tabs, which sit in a drag
            // titlebar but are re-enabled by a no-drag on their own container
            // -- and which a real click proves do work.
            if (region === "no-drag") return false;
        }
        return false;
      }).map((el) => (el.textContent || el.placeholder || el.tagName).trim())
    `);
    check("no control sits inside a -webkit-app-region: drag container", inDrag.length === 0, JSON.stringify(inDrag));

    check("the activation code is on screen", (await bodyText()).includes(DISPLAY_CODE));
    check("addressed to the number the API returned", (await bodyText()).includes(SEND_TO));
    check("the app asked Plow for exactly one code", seen.activate === 1, `${seen.activate}`);
    await shot("1-activate");

    // 3. The user texts the code. The app is polling and must move on by itself.
    say('the user texts "Plow Activate: Z1SWY"');
    activationCompleted = true;
    check("the app noticed without being told", await waitForText("This Mac is connected"));
    check("it minted the device credential", seen.devices === 1, JSON.stringify(devicesBody));
    check(
      "retiring the login session in the same call",
      devicesBody?.revoke_calling_session === true,
    );
    check("the device socket is up", relay.deviceOnline);
    check("settings hold the credential the server issued", loadCredential() === DEVICE_TOKEN);
    await shot("2-connected");

    // 4. THE HANDOVER. The wizard's last button is the only way into the app —
    //    the main window has not existed until this click. Real click at real
    //    coordinates, and the assertion is on the app's window list.
    //
    //    (Minting a client credential used to be driven from here. It is not on
    //    this screen any more: connecting an MCP client is per-client and
    //    repeatable, so it belongs in the main window, and Chunk 2 drives it
    //    there.)
    say("the user clicks Continue");
    const cont = await locate(
      `[...document.querySelectorAll("button")].find(b => /Continue/.test(b.textContent))`,
    );
    check("Continue is reachable at its own coordinates", cont?.reachable === true, cont?.onTop);
    await click({ x: cont.x, y: cont.y });

    // THE GATE (b): signed in, the main window is the only window — the setup
    // window closed itself rather than lingering behind it.
    check(
      "Continue hands over to the main window, and the setup window is gone",
      await waitForWindows(onlyMain),
      JSON.stringify(windowTitles()),
    );

    // 5. The same sweep on the MAIN window. Its tab bar lives inside
    //    `.titlebar`, which IS a drag region — `.seg` carries `no-drag` to get
    //    the buttons back, and reading that off the stylesheet is exactly the
    //    kind of proof that failed here before. So click one for real.
    say("the main window's tab bar, which sits inside a drag region");
    const main = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes("Domo Desktop"));
    check("the main window is there", !!main);
    if (main) {
      main.show();
      main.focus();
      main.webContents.focus();
      await sleep(500);
      const mainJs = (src) => main.webContents.executeJavaScript(src);
      const inDragMain = await mainJs(`
        [...document.querySelectorAll("input, button")].filter((el) => {
          for (let n = el; n; n = n.parentElement) {
            const region = getComputedStyle(n).webkitAppRegion;
            if (region === "drag") return true;
            // Not inherited: the NEAREST declaration wins. Walking up for any
            // drag would flag the main window's tabs, which sit in a drag
            // titlebar but are re-enabled by a no-drag on their own container
            // -- and which a real click proves do work.
            if (region === "no-drag") return false;
          }
          return false;
        }).map((el) => (el.textContent || el.placeholder || el.tagName).trim())
      `);
      check("no main-window control is trapped in a drag region", inDragMain.length === 0, JSON.stringify(inDragMain));

      const goals = await mainJs(`
        (() => {
          const el = document.querySelector('#seg button[data-tab="goals"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
          const top = document.elementFromPoint(x, y);
          return { x, y, reachable: top === el || el.contains(top) };
        })()
      `);
      check("the Goals tab is reachable at its own coordinates", goals?.reachable === true);
      main.webContents.sendInputEvent({ type: "mouseDown", x: goals.x, y: goals.y, button: "left", clickCount: 1 });
      await sleep(40);
      main.webContents.sendInputEvent({ type: "mouseUp", x: goals.x, y: goals.y, button: "left", clickCount: 1 });
      await sleep(400);
      // The side effect, not the class we clicked: the app persisted the tab.
      const stored = JSON.parse(fs.readFileSync(path.join(home, "app/settings.json"), "utf8")).selectedTab;
      check("clicking it actually switches tabs", stored === "goals", `selectedTab=${stored}`);
      await shot("3-main-window", main);
    }

    // 7. A REAL agent call, through the relay, into the app that is hosting the
    //    MCP server — and the approval dialog answered by a real click.
    //
    //    Read-only does NOT auto-allow: `PolicyEngine.decide`
    //    (packages/device-core/src/policyEngine.ts:64) has no capability-kind
    //    fast path, it goes straight to the delegate, which in this app is the
    //    human dialog. So the click is genuinely required, and no bypass flag
    //    exists or should. `always_allow` is the product's own escape hatch: it
    //    persists a rule and later identical calls need nobody.
    say("an agent calls read_file through the relay — the app must ask a human");
    const nonce = `nonce-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const proofFile = path.join(home, "proof.txt");
    fs.writeFileSync(proofFile, nonce);

    const AGENT = { agent_id: "agent-drive", agent_name: "Drive Harness" };
    const call = () =>
      relay.agentCall(
        {
          method: "POST",
          path: "/v1/relay/devices/u_drive/mcp",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-method": "tools/call",
            "mcp-name": "read_file",
            "mcp-protocol-version": MCP_PROTOCOL,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "read_file",
              arguments: { path: proofFile },
              _meta: {
                "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL,
                "io.modelcontextprotocol/clientInfo": { name: "drive-harness", version: "1" },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        },
        AGENT,
        60_000,
      );

    const first = call();
    // The dialog is its own window. Wait for it, hit-test it, click it for real.
    const approval = await waitForWindow("Approve");
    check("the app opened an approval dialog rather than auto-allowing", !!approval);
    if (approval) {
      approval.show();
      approval.focus();
      approval.webContents.focus();
      await sleep(500);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, "drive-4-approval.png"),
        (await approval.webContents.capturePage()).toPNG(),
      );
      const btn = await approval.webContents.executeJavaScript(`
        (() => {
          const el = [...document.querySelectorAll("button")]
            .find((b) => /Always Allow/i.test(b.textContent));
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
          const top = document.elementFromPoint(x, y);
          return { x, y, reachable: top === el || el.contains(top) };
        })()
      `);
      check("the Always Allow button is reachable at its own coordinates", btn?.reachable === true);
      approval.webContents.sendInputEvent({ type: "mouseDown", x: btn.x, y: btn.y, button: "left", clickCount: 1 });
      await sleep(40);
      approval.webContents.sendInputEvent({ type: "mouseUp", x: btn.x, y: btn.y, button: "left", clickCount: 1 });
    }

    const firstResult = await first;
    const firstPayload = JSON.parse(JSON.parse(firstResult.body).result.content[0].text);
    // The nonce is the proof: it exists only in a file this run wrote on THIS
    // machine, so a reply carrying it cannot have come from anywhere else.
    check("the call really executed on this Mac", firstPayload.content === nonce, firstPayload.content);

    // The click persisted a rule, so an identical call is now unattended. This
    // is what makes a 3am run possible without a bypass.
    say("the same agent makes the same call again");
    const before = BrowserWindow.getAllWindows().length;
    const secondResult = await call();
    const secondPayload = JSON.parse(JSON.parse(secondResult.body).result.content[0].text);
    check("it went through with the same result", secondPayload.content === nonce);
    check("with no dialog this time", BrowserWindow.getAllWindows().length === before);

    const rules = JSON.parse(fs.readFileSync(path.join(home, "device/rules.json"), "utf8"));
    check("and a rule was persisted for later runs", rules.length === 1, `${rules.length} rule(s)`);
    // The seam e2egate needs: this key is SHA-256 over agent + device +
    // normalized capabilities (packages/protocol/src/capability.ts:58). Same
    // agent, same device, same exact capability shape, or it prompts again.
    say(`rule key (stable only for this agent + device + capability shape): ${rules[0]?.ruleKey}`);

    // 8. THE GATE (c): signing out puts this Mac back behind it. Driven the way
    //    a person does it — Settings tab, Sign Out button, real clicks — because
    //    the interesting part is what the app does to its own windows, and an
    //    IPC call would prove only that the handler runs.
    say("the user signs out from Settings");
    if (main && !main.isDestroyed()) {
      const mainJs = (src) => main.webContents.executeJavaScript(src);
      const at = async (selector) =>
        mainJs(`
          (() => {
            const el = ${selector};
            if (!el) return null;
            const r = el.getBoundingClientRect();
            const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
            const top = document.elementFromPoint(x, y);
            return { x, y, reachable: top === el || el.contains(top) };
          })()
        `);
      const clickMain = async (where) => {
        main.webContents.sendInputEvent({ type: "mouseDown", ...where, button: "left", clickCount: 1 });
        await sleep(40);
        main.webContents.sendInputEvent({ type: "mouseUp", ...where, button: "left", clickCount: 1 });
        await sleep(400);
      };

      const settingsTab = await at(`document.querySelector('#seg button[data-tab="settings"]')`);
      check("the Settings tab is reachable at its own coordinates", settingsTab?.reachable === true);
      await clickMain(settingsTab);

      const signOut = await at(
        `[...document.querySelectorAll("button")].find(b => /Sign Out/i.test(b.textContent))`,
      );
      check("Sign Out is reachable at its own coordinates", signOut?.reachable === true);
      await shot("5-settings-signed-in", main);
      await clickMain(signOut);

      check(
        "signing out takes the main window away and puts the gate back",
        await waitForWindows(onlySetup),
        JSON.stringify(windowTitles()),
      );
      check("the credential is gone from settings", loadCredential() === "");
      check("and the device socket went down with it", await waitFor(() => !relay.deviceOnline));
      const gateWin = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes("Set Up"));
      if (gateWin) {
        gateWin.show();
        await sleep(400);
        await shot("6-gate-after-signout", gateWin);
      }
    }
} catch (error) {
    check(`the run completed without throwing`, false, String(error));
}

  function loadCredential() {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, "app/settings.json"), "utf8")).relayCredential;
    } catch {
      return null;
    }
}

  async function waitFor(predicate, ms = 20_000) {
    for (let i = 0; i < ms / 100; i += 1) {
      if (predicate()) return true;
      await sleep(100);
    }
    return false;
}

  console.log(failures === 0 ? "every check passed" : `${failures} check(s) FAILED`);
  app.exit(failures === 0 ? 0 : 1);
}

// No top-level await anywhere above: Electron does not emit `ready` until this
// entry module finishes evaluating, and the app's own main.js hangs its whole
// startup off `app.whenReady()`. A top-level await here means the app under
// test never boots.
main().catch((error) => {
    console.log(`CHECK FAIL the harness itself threw — ${error?.stack ?? error}`);
    app.exit(1);
});
