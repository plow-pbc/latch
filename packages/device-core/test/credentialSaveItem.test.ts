/**
 * Writing a login from the app, end to end.
 *
 * Two things have to hold, and neither is visible from the outside: the
 * password reaches the broker on stdin (a command line is readable by every
 * process on this machine), and a login is never stored without a site — one
 * that has none is exactly the item the fill path refuses later.
 *
 * The second test drives the REAL broker against a stand-in vault tool, so the
 * item that would go to the vault is inspected as it was actually built.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialBroker } from "@domo/device-core";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const brokerDir = path.join(repo, "vendor/browser-server");
const sitePackages = path.join(repo, "vendor/python-runtime/site-packages");

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A stand-in broker that reports the argv and stdin it was handed. */
function echoBroker(): string {
  const file = path.join(tmp("domo-save-"), "echo.cjs");
  fs.writeFileSync(
    file,
    `let stdin = "";
     process.stdin.on("data", (c) => (stdin += c));
     process.stdin.on("end", () => {
       process.stdout.write(JSON.stringify({ id: process.argv.slice(2).join(" "), title: stdin }));
     });`,
  );
  return file;
}

describe("saving an item", () => {
  it("puts the whole item on stdin, never in argv", async () => {
    const broker = new CredentialBroker({ command: ["node", echoBroker()] });
    const seen = await broker.saveItem({
      type: "login",
      name: "GitHub",
      username: "me@example.com",
      urls: ["https://github.com"],
      password: "hunter2",
    });
    expect(seen.id).toBe("save-item");
    expect(seen.id).not.toContain("hunter2");
    expect(JSON.parse(seen.title)).toEqual({
      type: "login",
      name: "GitHub",
      username: "me@example.com",
      urls: ["https://github.com"],
      password: "hunter2",
    });
  });

  it("names the item to change in argv, and nothing else", async () => {
    const broker = new CredentialBroker({ command: ["node", echoBroker()] });
    const seen = await broker.saveItem({ itemId: "abc", name: "GitHub" });
    expect(seen.id).toBe("save-item --item-id abc");
    expect(JSON.parse(seen.title)).toEqual({ name: "GitHub" });
  });
});

/** A stand-in `bw` that answers the calls the broker makes, and keeps the item. */
function fakeVaultTool(outPath: string): string {
  const file = path.join(tmp("domo-bw-"), "bw.cjs");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
     const fs = require("fs");
     const args = process.argv.slice(2).filter((a) => a !== "--nointeraction");
     const [verb, ...rest] = args;
     if (verb === "status") { process.stdout.write(JSON.stringify({ serverUrl: "https://vault.local", status: "unlocked" })); process.exit(0); }
     if (verb === "unlock" || verb === "login") { process.stdout.write("session-key"); process.exit(0); }
     if (verb === "sync" || verb === "config") { process.exit(0); }
     if (verb === "list") { process.stdout.write("[]"); process.exit(0); }
     if (verb === "create" || verb === "edit") {
       const encoded = fs.readFileSync(0, "utf8");
       const item = JSON.parse(Buffer.from(encoded, "base64").toString());
       fs.writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(item));
       process.stdout.write(JSON.stringify({ id: "item-1", name: item.name }));
       process.exit(0);
     }
     process.exit(1);`,
    { mode: 0o755 },  // the broker execs it, so it has to be runnable
  );
  return file;
}

const havePython = fs.existsSync(path.join(sitePackages, "tldextract"));

describe.skipIf(!havePython)("what the broker actually writes to the vault", () => {
  function saveItem(args: string[], item: unknown): { stdout: string; item: unknown } {
    const outPath = path.join(tmp("domo-item-"), "item.json");
    const stdout = execFileSync(
      "python3",
      ["-m", "seed_vault_broker", "save-item", ...args],
      {
        cwd: brokerDir,
        input: JSON.stringify(item),
        encoding: "utf8",
        env: {
          ...process.env,
          PYTHONPATH: `${brokerDir}:${sitePackages}`,
          SEED_VAULT_BW: fakeVaultTool(outPath),
          SEED_VAULT_URL: "https://vault.local",
          SEED_VAULT_PERSON: "me",
          SEED_VAULT_USER: "agent@local",
          SEED_VAULT_PASSWORD: "vault-password",
          SEED_VAULT_STATE: tmp("domo-state-"),
          SEED_VAULT_AUDIT: path.join(tmp("domo-audit-"), "audit.log"),
        },
      },
    );
    return {
      stdout,
      item: fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : null,
    };
  }

  it("stores the site, so the login can be filled later", () => {
    const { stdout, item } = saveItem([], {
      type: "login",
      name: "GitHub",
      username: "me@example.com",
      password: "hunter2",
      urls: ["https://github.com"],
    });
    expect(JSON.parse(stdout)).toEqual({ id: "item-1", title: "GitHub" });
    expect(item).toMatchObject({
      type: 1,
      name: "GitHub",
      login: {
        username: "me@example.com",
        password: "hunter2",
        uris: [{ match: null, uri: "https://github.com" }],
      },
    });
  });

  it("refuses a login with no site at all", () => {
    expect(() => saveItem([], { type: "login", name: "Nowhere", password: "hunter2" })).toThrow(
      /at least one site URL/,
    );
  });

  it("writes a card as a card, with its own fields and no site", () => {
    const { stdout, item } = saveItem([], {
      type: "card",
      name: "Amex",
      cardholderName: "Daniel Delattre",
      number: "371449635398431",
      expMonth: "04",
      expYear: "2030",
      code: "1234",
    });
    expect(JSON.parse(stdout)).toEqual({ id: "item-1", title: "Amex" });
    expect(item).toMatchObject({
      type: 3,
      name: "Amex",
      card: { cardholderName: "Daniel Delattre", number: "371449635398431", code: "1234" },
    });
  });

  it("writes a secure note, whose body is the note itself", () => {
    const { item } = saveItem([], { type: "note", name: "Wifi", notes: "the password is on the router" });
    expect(item).toMatchObject({ type: 2, name: "Wifi", notes: "the password is on the router" });
  });
});
