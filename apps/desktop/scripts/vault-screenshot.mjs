// Render the REAL main window's Vault tab offscreen, with the REAL preload,
// the REAL CredentialBroker and the REAL broker CLI, and capture one PNG per
// state: the list, the New login form, and the list again with the login that
// was just added. Like connect-screenshot.mjs it EXITS NON-ZERO if a screen is
// missing the content it exists to show.
//
//   just vault-screenshot                → /tmp/vault-*.png
//   OUT_DIR=/path just vault-screenshot
//
// What is stood in for is the vault itself and nothing else: `bw` is replaced
// by a script that keeps items in a JSON file, so everything above it — the
// broker's item building and its refusal of a site-less login, the IPC
// handlers, the preload bridge, the tab — is the shipping code, and the login
// on the last screen really was created through it.
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");
const repo = path.resolve(dir, "../../..");
const outDir = process.env.OUT_DIR ?? "/tmp";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "vault-shot-"));
const itemsPath = path.join(state, "items.json");

/** A stand-in `bw`: it keeps the vault's items in one JSON file. */
function fakeVaultTool() {
  const file = path.join(state, "bw.cjs");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
     const fs = require("fs");
     const P = ${JSON.stringify(itemsPath)};
     const read = () => { try { return JSON.parse(fs.readFileSync(P, "utf8")); } catch { return []; } };
     const write = (v) => fs.writeFileSync(P, JSON.stringify(v));
     const args = process.argv.slice(2).filter((a) => a !== "--nointeraction");
     const [verb, ...rest] = args;
     if (verb === "status") { process.stdout.write(JSON.stringify({ serverUrl: "https://vault.local", status: "unlocked" })); process.exit(0); }
     if (verb === "unlock" || verb === "login") { process.stdout.write("session-key"); process.exit(0); }
     if (verb === "sync" || verb === "config") { process.exit(0); }
     if (verb === "list") { process.stdout.write(JSON.stringify(read())); process.exit(0); }
     if (verb === "get" && rest[0] === "item") {
       const found = read().find((i) => i.id === rest[1]);
       if (!found) { process.stderr.write("not found"); process.exit(1); }
       process.stdout.write(JSON.stringify(found));
       process.exit(0);
     }
     if (verb === "create" || verb === "edit") {
       const item = JSON.parse(Buffer.from(fs.readFileSync(0, "utf8"), "base64").toString());
       const items = read();
       if (verb === "edit") {
         const at = items.findIndex((i) => i.id === rest[1]);
         items[at] = { ...item, id: rest[1] };
       } else {
         item.id = "item-" + (items.length + 1);
         items.push(item);
       }
       write(items);
       const saved = verb === "edit" ? items.find((i) => i.id === rest[1]) : items[items.length - 1];
       process.stdout.write(JSON.stringify(saved));
       process.exit(0);
     }
     process.exit(1);`,
    { mode: 0o755 }, // the broker execs it, so it has to be runnable
  );
  return file;
}

// One login that was already there, so the list has something on it before the
// screen that adds the second.
fs.writeFileSync(
  itemsPath,
  JSON.stringify([
    {
      id: "item-1",
      name: "Product Hunt",
      type: 1,
      login: { username: "daniel@plow.co", password: "already-stored", uris: [{ uri: "https://www.producthunt.com" }] },
    },
    {
      id: "item-2",
      name: "Amex",
      type: 3,
      card: { cardholderName: "Daniel Delattre", brand: "amex", number: "371449635398431", expMonth: "04", expYear: "2030", code: "1234" },
    },
  ]),
);

async function setUp() {
  const { CredentialBroker } = await import(path.join(repo, "packages/device-core/dist/index.js"));
  const brokerDir = path.join(repo, "vendor/browser-server");
  const broker = new CredentialBroker({
    command: ["python3", "-m", "seed_vault_broker"],
    env: {
      PYTHONPATH: `${brokerDir}:${path.join(repo, "vendor/python-runtime/site-packages")}`,
      SEED_VAULT_BW: fakeVaultTool(),
      SEED_VAULT_URL: "https://vault.local",
      SEED_VAULT_PERSON: "daniel@plow.co",
      SEED_VAULT_USER: "agent@local",
      SEED_VAULT_PASSWORD: "vault-password",
      SEED_VAULT_STATE: path.join(state, "broker"),
      SEED_VAULT_AUDIT: path.join(state, "audit.log"),
    },
  });

  // The Vault tab's IPC surface — the same handlers main.ts registers, over the
  // same broker methods.
  ipcMain.handle("vault:items", async () => broker.whatsHere());
  ipcMain.handle("vault:item", async (_e, itemId) => broker.readItem(String(itemId)));
  ipcMain.handle("vault:reveal", async (_e, itemId, field) => broker.revealField(String(itemId), String(field)));
  ipcMain.handle("vault:saveItem", async (_e, input) => broker.saveItem(input));
  ipcMain.handle("status:get", async () => ({ deviceId: "dev_example", name: "Example Mac", connected: true }));
  ipcMain.handle("ui:getTab", async () => "vault");
  ipcMain.handle("ui:setTab", async () => {});
  ipcMain.handle("updates:get", async () => ({
    supported: false,
    currentVersion: "0.0.0-shot",
    autoCheck: false,
    autoInstall: false,
    phase: "idle",
    availableVersion: null,
    lastCheckAt: null,
    error: null,
    dismissed: false,
    upToDate: false,
  }));
}

/** Each shot: how to get the screen into that state, and what must be on it. */
const SCREENS = [
  {
    name: "list",
    prepare: async () => {},
    // The heading is uppercased by the stylesheet, so that is how it reads back.
    expect: ["YOUR SECRETS", "New", "Product Hunt", "Login", "Amex", "Card"],
  },
  {
    name: "types",
    prepare: async (win) => clickText(win, "New"),
    // Every type the vault models is offered, not only logins.
    expect: ["What are you saving?", "Login", "Card", "Identity", "Secure note"],
  },
  {
    name: "card-form",
    prepare: async (win) => {
      await clickText(win, "New");
      await clickText(win, "Card");
    },
    expect: ["Item name", "Cardholder name", "Brand", "Number", "Expiry month", "Expiry year", "Security code", "Add card"],
  },
  {
    name: "identity-form",
    prepare: async (win) => {
      await clickText(win, "New");
      await clickText(win, "Identity");
    },
    expect: ["First name", "Last name", "Address 1", "Postal code", "SSN", "Passport number", "Licence number"],
  },
  {
    name: "open-login",
    prepare: async (win) => {
      await clickText(win, "Open");
      await settle(win);
      await clickText(win, "Show");
      await settle(win);
    },
    // Opened, and the stored password fetched because the owner asked for it.
    // The value lands in a field, so it is checked as a value, not as page text.
    expect: ["Site URL", "TOTP secret", "Shown"],
    expectValues: ["already-stored"],
  },
  {
    name: "added",
    prepare: async (win) => {
      await clickText(win, "New");
      await clickText(win, "Login");
      await type(win, "Item name", "GitHub");
      await type(win, "Username", "daniel@plow.co");
      await type(win, "Site URL", "https://github.com");
      await type(win, "Password", "a-new-password");
      await clickText(win, "Add login");
      await settle(win);
    },
    // Written through the broker and read back from the vault — no browser page
    // anywhere in that loop.
    expect: ["GitHub", "Product Hunt", "Amex"],
  },
];

/** Click by visible label, the way a person picks a button out of the page. */
async function clickText(win, label) {
  const found = await win.webContents.executeJavaScript(`
    (() => {
      const el = [...document.querySelectorAll("button")]
        .find((b) => b.textContent.includes(${JSON.stringify(label)}));
      if (!el) return false;
      el.click();
      return true;
    })()
  `);
  if (!found) throw new Error(`no button labelled ${label}`);
  await new Promise((r) => setTimeout(r, 250));
}

/** Type into the field under a label, the way the form is filled by hand. */
async function type(win, label, text) {
  const found = await win.webContents.executeJavaScript(`
    (() => {
      const field = [...document.querySelectorAll(".field")]
        .find((f) => (f.querySelector("label")?.textContent || "").replace(" (optional)", "") === ${JSON.stringify(label)});
      const el = field?.querySelector("input");
      if (!el) return false;
      el.value = ${JSON.stringify(text)};
      return true;
    })()
  `);
  if (!found) throw new Error(`no field labelled ${label}`);
}

/** The broker is a process per call; give the answer time to come back. */
async function settle(win) {
  await new Promise((r) => setTimeout(r, 1500));
}

/** Wait for the listing to arrive, rather than guessing how long it takes. */
async function listed(win) {
  for (let i = 0; i < 40; i++) {
    const ready = await win.webContents.executeJavaScript(
      `!!document.querySelector(".item, .empty")`,
    );
    if (ready) {
      // The text is in the DOM one tick before it is painted; a shot taken on
      // that tick is a blank window with the right innerText.
      await new Promise((r) => setTimeout(r, 400));
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the vault tab never listed anything");
}

process.on("unhandledRejection", (error) => {
  console.error("SHOT-FAILED:", error);
  app.exit(1);
});

app.whenReady().then(async () => {
  await setUp();
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 940,
    height: 620,
    show: false,
    webPreferences: {
      preload: path.join(dist, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  let failures = 0;
  for (const screen of SCREENS) {
    await win.loadFile(path.join(dist, "renderer/index.html"));
    await listed(win); // the tab is empty until the broker answers
    await screen.prepare(win);

    const out = path.join(outDir, `vault-${screen.name}.png`);
    fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());

    const text = await win.webContents.executeJavaScript("document.body.innerText");
    const values = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll("input, textarea")].map((f) => f.value).join("\\n")`,
    );
    const missing = [
      ...screen.expect.filter((needle) => !text.includes(needle)),
      ...(screen.expectValues ?? []).filter((needle) => !values.includes(needle)),
    ];
    if (missing.length) failures += 1;
    console.log("SHOT:" + JSON.stringify({ screen: screen.name, out, missing }));
  }
  app.exit(failures ? 1 : 0);
});
