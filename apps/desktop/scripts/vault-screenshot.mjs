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
import { app, ipcMain } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clickText, failLoudly, shootScreens, shotWindow, waitFor } from "./screenshot-harness.mjs";
import {
  checkedUrls,
  decryptField,
  decryptItem,
  decryptSummary,
  encryptCipher,
  splitKey,
  TYPE_CODE,
} from "@domo/device-core";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");
const outDir = process.env.OUT_DIR ?? "/tmp";

const account = splitKey(crypto.randomBytes(64));

/** The vault's items, as ciphers — the same shape the server stores. */
const ciphers = new Map();
let nextId = 1;

/** Product Hunt's URL entries as they were before a site was removed. */
let phUris = [];

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
  // Three, because one site proves nothing about removing the right one.
  urls: ["https://www.producthunt.com", "https://ph.co", "https://api.producthunt.com"],
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
    const type = existing?.type ?? TYPE_CODE[input.type ?? "login"];
    const given =
      type === 1 && !existing ? { ...input, urls: checkedUrls(input.urls ?? []) } : input;
    const id = input.itemId ?? `item-${nextId++}`;
    ciphers.set(id, { ...encryptCipher(given, existing, account), id });
    return { id, title: String(input.name ?? "") };
  });
  ipcMain.handle("vault:deleteItem", async (_e, itemId) => {
    ciphers.delete(itemId);
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
    expect: ["Vault", "typed on this Mac, never handed to them", "Saved items", "2 items",
             "Product Hunt", "Login", "Amex", "Card"],
  },
  {
    name: "types",
    prepare: async (win) => clickText(win, "New"),
    // Every type the vault models is offered, not only logins.
    expect: ["What are you saving to the vault?", "Login", "Card", "Identity", "Secure note",
             "Username, password & 2FA for a site"],
  },
  {
    name: "card-form",
    prepare: async (win) => {
      await clickText(win, "New");
      await clickText(win, "Payment card for checkout");
    },
    expect: ["New card", "Card details", "Cardholder name", "Number", "Expiration month",
             "Security code (CVV)", "Notes", "Required"],
  },
  {
    name: "identity-form",
    prepare: async (win) => {
      await clickText(win, "New");
      await clickText(win, "Name, address & contact details");
    },
    expect: ["Name", "First name", "Last name", "Address 1", "ZIP / Postal code", "Social Security number", "Passport number"],
  },
  {
    name: "open-login",
    prepare: async (win) => {
      await clickText(win, "Product Hunt");
      await settle(win);
      await clickEye(win);
      await settle(win);
    },
    // Opened, and the stored password fetched because the owner asked for it.
    expect: ["Login credentials", "Authenticator key (TOTP)", "Website (URI)", "Add website",
             "Used by agents on approval", "Delete", "Save"],
    expectValues: ["already-stored"],
  },
  {
    name: "added",
    prepare: async (win) => {
      await clickText(win, "New");
      await clickText(win, "Username, password & 2FA for a site");
      await type(win, "Item name", "GitHub");
      await type(win, "Username", "daniel@plow.co");
      await type(win, "Password", "a-new-password");
      await typeUrl(win, "https://github.com");
      await clickText(win, "Save");
      await settle(win);
    },
    // Written through the real encryption and read back — no browser page
    // anywhere in that loop.
    expect: ["GitHub", "Product Hunt", "Amex", "3 items"],
  },
  {
    name: "dropped-url",
    prepare: async (win) => {
      phUris = ciphers.get("item-1").login.uris.map((u) => u.uri);
      await clickText(win, "Product Hunt");
      await settle(win);
      await removable(win, 3, "before the removal");
      await dropUrl(win, 1);
      // The website group sits below the fold in this window, and it is the
      // whole subject of this shot.
      await showUrls(win);
      await settle(win);
    },
    // The middle box is gone from the form; the two it kept are still there.
    expectValues: ["https://www.producthunt.com", "https://api.producthunt.com"],
    after: async (win) => {
      await clickText(win, "Save");
      await settle(win);
      const item = ciphers.get("item-1");
      const urls = decryptItem(item, account).urls;
      const want = ["https://www.producthunt.com", "https://api.producthunt.com"];
      if (JSON.stringify(urls) !== JSON.stringify(want)) {
        throw new Error(`removed site not dropped: stored ${JSON.stringify(urls)}, wanted ${JSON.stringify(want)}`);
      }
      // And the two it kept are the entries they already were. A removal that
      // renumbered the boxes would reconcile the last one against the entry
      // above it, rewriting a URL nobody touched — invisible above, and the
      // reason the removed row is emptied in place rather than spliced out.
      const kept = item.login.uris.map((u) => u.uri);
      if (kept[0] !== phUris[0] || kept[1] !== phUris[2]) {
        throw new Error("removing a site shifted the ones below it onto other entries");
      }
      // GitHub has the one site it was saved with, and no way to remove it: a
      // login with no URL can never be filled, so the form never offers that.
      await clickText(win, "GitHub");
      await settle(win);
      await removable(win, 0, "on a login with a single site");
    },
  },
];

/** How many websites can be removed right now, and how many should be. */
async function removable(win, n, when) {
  const shown = await win.webContents.executeJavaScript(
    `document.querySelectorAll(".vaultui .mini.drop:not([hidden])").length`,
  );
  if (shown !== n) throw new Error(`${shown} remove buttons ${when}, wanted ${n}`);
}

/** Bring the website group into the frame. */
async function showUrls(win) {
  await win.webContents.executeJavaScript(
    `(() => { const h = [...document.querySelectorAll(".vaultui .group-h")].find((e) => e.textContent.startsWith("Website")); h?.scrollIntoView({ block: "center" }); })()`,
  );
}

/** Click the remove button on the nth website box, the way a person does. */
async function dropUrl(win, nth) {
  const found = await win.webContents.executeJavaScript(
    `(() => { const b = document.querySelectorAll(".vaultui .mini.drop")[${nth}]; if (!b) return false; b.click(); return true; })()`,
  );
  if (!found) throw new Error(`no remove button on website box ${nth}`);
}

/** The first eye button on screen — how a person asks to see a stored secret. */
async function clickEye(win) {
  const found = await win.webContents.executeJavaScript(
    `(() => { const b = document.querySelector(".vaultui .mini.eye"); if (!b) return false; b.click(); return true; })()`,
  );
  if (!found) throw new Error("no reveal button on screen");
  await new Promise((r) => setTimeout(r, 250));
}

/** The website box, which carries no label of its own in her design. */
async function typeUrl(win, url) {
  const found = await win.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector('.vaultui .sheet input[placeholder="https://"]');
      if (!el) return false;
      el.value = ${JSON.stringify("URL")};
      return true;
    })()`.replace(JSON.stringify("URL"), JSON.stringify(url)),
  );
  if (!found) throw new Error("no website field on screen");
}

/** Type into the field under a label, the way the form is filled by hand. */
async function type(win, label, text) {
  const found = await win.webContents.executeJavaScript(`
    (() => {
      const field = [...document.querySelectorAll(".field")]
        .find((f) => (f.querySelector("label")?.textContent || "").replace(/[\\s*]+$/, "") === ${JSON.stringify(label)});
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

failLoudly();

app.whenReady().then(async () => {
  await setUp();
  const win = shotWindow(dist);
  const failures = await shootScreens({
    win,
    outDir,
    prefix: "vault",
    screens: SCREENS,
    load: async () => {
      await win.loadFile(path.join(dist, "renderer/index.html"));
      // The tab is empty until the vault answers, and the text is in the DOM one
      // tick before it is painted: a shot on that tick is a blank window with
      // the right innerText.
      await waitFor(win, `document.querySelector(".vaultui .vitem, .vaultui .empty")`, "the vault tab to list");
      await new Promise((r) => setTimeout(r, 400));
    },
  });
  app.exit(failures ? 1 : 0);
});
