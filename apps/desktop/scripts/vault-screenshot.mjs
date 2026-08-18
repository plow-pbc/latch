// Render the REAL main window's Vault tab offscreen, with the REAL preload and
// the REAL item encryption, and capture one PNG per state: the list, the type
// picker, a card form, an identity form, an item opened with its password
// shown, and the list again with the login that was just added. Like
// connect-screenshot.mjs it EXITS NON-ZERO if a screen is missing the content
// it exists to show.
//
//   just vault-screenshot                → /tmp/vault-*.png
//   OUT_DIR=/path just vault-screenshot
//
// What is stood in for is the vault SERVER and nothing else: the items live in
// a Map here instead of behind HTTPS, but they are encrypted and decrypted by
// the shipping code with a real account key, so what the screens show came
// through the same crypto the app uses against the real vault.
import { app, BrowserWindow, ipcMain } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkedUrls,
  decryptField,
  decryptItem,
  decryptSummary,
  encryptCipher,
  splitKey,
} from "@domo/device-core";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");
const outDir = process.env.OUT_DIR ?? "/tmp";

const account = splitKey(crypto.randomBytes(64));

/** The vault's items, as ciphers — the same shape the server stores. */
const ciphers = new Map();
let nextId = 1;

function seed(input) {
  const id = `item-${nextId++}`;
  ciphers.set(id, { ...encryptCipher(input, null, account), id });
}

// Two items that were already there, of two different types, so the list shows
// what "every type" means before anything is added to it.
seed({
  type: "login",
  name: "Product Hunt",
  username: "daniel@plow.co",
  password: "already-stored",
  urls: ["https://www.producthunt.com"],
});
seed({
  type: "card",
  name: "Amex",
  cardholderName: "Daniel Delattre",
  brand: "amex",
  number: "371449635398431",
  expMonth: "04",
  expYear: "2030",
  code: "1234",
});

async function setUp() {
  // The Vault tab's IPC surface — the same calls main.ts registers, over the
  // same encryption, against items held here instead of behind the vault.
  ipcMain.handle("vault:items", async () =>
    [...ciphers.values()].map((c) => decryptSummary(c, account)),
  );
  ipcMain.handle("vault:item", async (_e, itemId) => decryptItem(ciphers.get(itemId), account));
  ipcMain.handle("vault:reveal", async (_e, itemId, field) =>
    decryptField(ciphers.get(itemId), account, field),
  );
  ipcMain.handle("vault:saveItem", async (_e, input) => {
    const existing = input.itemId ? ciphers.get(input.itemId) : null;
    const type = existing?.type ?? { login: 1, note: 2, card: 3, identity: 4 }[input.type ?? "login"];
    const given = type === 1 ? { ...input, urls: checkedUrls(input.urls ?? []) } : input;
    const id = input.itemId ?? `item-${nextId++}`;
    ciphers.set(id, { ...encryptCipher(given, existing, account), id });
    return { id, title: String(input.name ?? "") };
  });
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

/** Give an IPC round trip and its render a moment to land. */
async function settle(win) {
  await new Promise((r) => setTimeout(r, 400));
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
