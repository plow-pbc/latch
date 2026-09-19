// On the test Mac after `just build`:
// OUT_DIR=/tmp/latch-new-agent-proof npx electron apps/desktop/scripts/verify-new-agent.mjs
// The real renderer, preload, state and IPC handler run against a fake API;
// shell.openExternal is captured so this check cannot send a real message.
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = process.env.UI_DIST ?? path.join(desktop, "dist");
const out = process.env.OUT_DIR;
if (!out) throw new Error("OUT_DIR is required");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "latch-new-agent-"));
app.setPath("userData", path.join(home, "electron"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mouseClick(win, expression) {
  const point = await win.webContents.executeJavaScript(`(() => {
    const target = ${expression};
    if (!target || target.disabled) throw new Error("Missing or disabled click target");
    const r = target.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!target.contains(document.elementFromPoint(x, y))) throw new Error("Click target obscured");
    return { x, y };
  })()`);
  console.log(`mouseDown/mouseUp at ${point.x},${point.y}: ${expression}`);
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  await delay(250);
}

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const { CloudAgentState } = await import(path.join(desktop, "dist/cloudAgentState.js"));
  const { CloudAgentsClient } = await import(path.join(desktop, "dist/cloudAgents.js"));
  const { PlowApi } = await import(path.join(desktop, "dist/plowApi.js"));
  const { saveSettings, loadSettings } = await import(path.join(desktop, "dist/settings.js"));
  saveSettings(home, { ...loadSettings(home), relayCredential: "fixture_device_credential" });
  let providers = [{ id: "exe:life", name: "Life", phrases: ["Start Life & café?", "alias"] }];
  let agentRows = [];
  let signupDown = false; // Plow's API mid-deploy: the catalog refresh 503s
  const requests = [], opened = [];
  const api = new PlowApi("https://fixture.invalid", async (url, init) => {
    requests.push(`${init.method} ${new URL(url).pathname}`);
    if (init.method === "PUT" && new URL(url).pathname === "/v1/agents/agent_1/line") {
      assert.equal(JSON.parse(init.body).line_uid, "lin_ash");
      agentRows[0] = { ...agentRows[0], line: { uid: "lin_ash", display_name: "Ash", provider_key: "+15557654321" } };
      return new Response(JSON.stringify(agentRows[0]), { status: 200 });
    }
    if (init.method !== "GET") throw new Error("Unexpected mutation");
    if (new URL(url).pathname === "/v1/signup") {
      assert.equal(new Headers(init.headers).has("authorization"), false);
      if (signupDown) return new Response("", { status: 503 });
    }
    const body = new URL(url).pathname === "/v1/signup"
      ? { managed_phone: "+15551234567", providers } : agentRows;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  let win;
  const cloudAgents = new CloudAgentState({
    home, agents: new CloudAgentsClient(api), providers: api,
    // Production's publish path: every change reaches the renderer, as in main.ts.
    onChange: () => win?.webContents.send("connect:changed"),
    chats: { list: async () => [{
      uid: "cht_ash", lineUid: "lin_ash", status: "active", memberCount: 1, hasOwnerMember: true,
      label: "Ash", recipients: { line: "+15557654321", members: ["+15550000001"] }, people: [],
    }] },
    lines: { list: async () => [{ uid: "lin_ash", agentUid: null, displayName: "Ash", number: "+15557654321" }] },
    agentIndex: async () => ({
      "exe:life": { blurb: "Runs a household.", builder: "Sam", users: 16, successRate: 88, verified: true, rank: 0, logo: null },
      "exe:hermes": { blurb: null, builder: null, users: 0, successRate: null, verified: true, rank: 1, logo: null },
      // Offered by Plow but not verified by the Index: the deploy modal leaves it out.
      "exe:draft": { blurb: null, builder: null, users: 0, successRate: null, verified: false, rank: 2, logo: null },
    }),
  });
  await cloudAgents.refresh();
  const state = () => ({
    ...cloudAgents.state(), hasCredential: true, busy: false, message: null,
    credential: null, agentToken: null, roster: [],
  });
  // Evaluate the shipping handler, not a duplicate that could hide an IPC bug.
  const source = ts.createSourceFile("main.ts", fs.readFileSync(path.join(desktop, "src/main.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const nodes = source.statements.filter((n) =>
    (ts.isFunctionDeclaration(n) && n.name?.text === "openSmsUrl") ||
    (ts.isExpressionStatement(n) && ['ipcMain.handle("cloud:newAgentMessages"', 'ipcMain.handle("cloud:awaitNewAgent"', 'ipcMain.handle("cloud:changeLine"'].some((prefix) => n.getText(source).startsWith(prefix))));
  vm.runInNewContext(ts.transpileModule(nodes.map((n) => n.getText(source)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, { ipcMain, cloudAgents, agentsTabState: state, shell: { openExternal: async (url) => { opened.push(url); console.log(`shell.openExternal: ${url}`); } } });
  for (const [channel, value] of Object.entries({
    "connect:get": state, "cloud:refresh": state,
    "status:get": () => ({ deviceId: "fixture", name: "Test Mac", connected: true }),
    "ui:getTab": () => "agents", "ui:setTab": () => {},
    "updates:get": () => ({ supported: false, phase: "idle" }),
    "capabilities:get": () => ({ view: { badgeCount: 0, groups: [], banner: null } }),
    "vault:exchangePending": () => null,
    // The baseline's click opens its old dialog; let it render for the red proof.
    "cloud:cancelLineFlow": state,
  })) ipcMain.handle(channel, value);

  win = new BrowserWindow({ width: 1040, height: 720, show: true, webPreferences: {
    preload: path.join(dist, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false,
  } });
  try {
    app.focus({ steal: true });
    win.focus();
    await win.loadURL('data:text/html,<button onclick="document.body.dataset.clicked=1">Control</button>');
    await mouseClick(win, 'document.querySelector("button")');
    assert.equal(await win.webContents.executeJavaScript('document.body.dataset.clicked'), "1");
    console.log("CONTROL PASS: coordinate click reached the page");
    await win.loadFile(path.join(dist, "renderer/index.html"));
    await delay(800);
    const newAgent = '[...document.querySelectorAll("button")].find(b => b.textContent === "New agent")';
    const card = (name) => `[...document.querySelectorAll(".deploy-card")].find(c => c.querySelector(".deploy-card-name").textContent === ${JSON.stringify(name)})`;
    const deployButton = '[...document.querySelectorAll(".deploy-modal button")].find(b => b.textContent.startsWith("Deploy"))';
    await mouseClick(win, newAgent);
    assert.equal(await win.webContents.executeJavaScript(`${deployButton}.disabled`), true);
    assert.equal(await win.webContents.executeJavaScript(`${card("Life")}.textContent.includes("by Sam · 16 people · 88% set up")`), true);
    await mouseClick(win, card("Life"));
    fs.writeFileSync(path.join(out, "deploy-picker.png"), (await win.webContents.capturePage()).toPNG());

    // Plow goes down while the modal is open: a refresh drops the catalog, so
    // Deploy has no setup text. It must say so, visibly, and open nothing.
    signupDown = true;
    await cloudAgents.refresh();
    const openedBefore = opened.length;
    await mouseClick(win, deployButton);
    assert.equal(opened.length, openedBefore);
    assert.deepEqual(await win.webContents.executeJavaScript('(n => [n.textContent, n.classList.contains("error")])(document.querySelector(".deploy-note"))'),
      ["Plow isn't answering right now. Try again in a minute.", true]);
    fs.writeFileSync(path.join(out, "deploy-plow-down.png"), (await win.webContents.capturePage()).toPNG());
    console.log("PASS: with Plow's catalog down, Deploy says so in error style and opens nothing");
    signupDown = false;
    await cloudAgents.refresh();
    await mouseClick(win, deployButton);
    assert.equal(opened.at(-1), "sms:+15551234567?&body=Start%20Life%20%26%20caf%C3%A9%3F");
    assert.equal(await win.webContents.executeJavaScript('!!document.querySelector(".deploy-wait")'), true);
    fs.writeFileSync(path.join(out, "deploy-waiting.png"), (await win.webContents.capturePage()).toPNG());
    console.log("PASS: New agent opens the deploy modal; Deploy opens the encoded phrase and waits");

    agentRows = [{ uid: "agent_new", name: "Life", provider: "exe:life", status: "provisioning",
      line: { uid: "lin_willow", display_name: "Willow", provider_key: "+15551111111" } }];
    await delay(6000);
    assert.equal(await win.webContents.executeJavaScript('!!document.querySelector(".deploy-modal")'), false);
    assert.equal(await win.webContents.executeJavaScript('!!document.querySelector("[data-cloud-agent-id=agent_new].cloud-agent-new")'), true);
    fs.writeFileSync(path.join(out, "deploy-arrived.png"), (await win.webContents.capturePage()).toPNG());
    console.log("PASS: the wait finds the new agent, closes the modal and highlights its row");

    providers = [...providers, { id: "exe:draft", name: "Draft", phrases: ["Start Draft"] }, { id: "exe:hermes", name: "Hermes", phrases: ["Start Hermes"] }];
    await cloudAgents.refresh();
    await delay(250);
    await mouseClick(win, newAgent);
    assert.deepEqual(await win.webContents.executeJavaScript('[...document.querySelectorAll(".deploy-card-name")].map(n => n.textContent)'), ["Life", "Hermes"]);
    await win.webContents.executeJavaScript(`${card("Hermes")}.focus()`);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await delay(150);
    assert.equal(await win.webContents.executeJavaScript(`${deployButton}.textContent`), "Deploy Hermes");
    await mouseClick(win, deployButton);
    assert.equal(opened.at(-1), "sms:+15551234567?&body=Start%20Hermes");
    await mouseClick(win, '[...document.querySelectorAll(".deploy-modal button")].find(b => b.textContent === "Close")');
    assert(requests.every((request) => request.startsWith("GET ")));
    console.log("PASS: keyboard selection deploys Hermes; no API mutations", JSON.stringify(requests));

    agentRows = [{ uid: "agent_1", name: "Life", provider: "exe:life", status: "running",
      line: { uid: "lin_willow", display_name: "Willow", provider_key: "+15551111111" } }];
    await cloudAgents.refresh();
    await delay(250);
    await mouseClick(win, 'document.querySelector(".cloud-agent-open")');
    await mouseClick(win, '[...document.querySelectorAll(".cloud-modal button")].find(b => b.textContent === "Change line")');
    fs.writeFileSync(path.join(out, "change-line.png"), (await win.webContents.capturePage()).toPNG());
    await mouseClick(win, '[...document.querySelectorAll(".cloud-modal button")].find(b => b.textContent.startsWith("Ash"))');
    assert.equal(cloudAgents.state().cloudAgents[0].line.uid, "lin_ash");
    assert(requests.includes("PUT /v1/agents/agent_1/line"));
    assert(!requests.some((request) => request.startsWith("POST ")));
    console.log("PASS: existing agent moves to Ash through PUT; no activation or creation");
  } finally {
    win.destroy();
    fs.rmSync(home, { recursive: true, force: true });
  }
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
