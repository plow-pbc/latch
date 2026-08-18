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

describe("saving a login", () => {
  it("puts the password on stdin, never in argv", async () => {
    const broker = new CredentialBroker({ command: ["node", echoBroker()] });
    const seen = await broker.saveItem({
      title: "GitHub",
      username: "me@example.com",
      urls: ["https://github.com"],
      password: "hunter2",
    });
    expect(seen.id).toBe(
      "save-item --title GitHub --username me@example.com --url https://github.com --password-stdin",
    );
    expect(seen.id).not.toContain("hunter2");
    expect(seen.title).toBe("hunter2");
  });

  it("leaves the password alone on an edit that does not set one", async () => {
    const broker = new CredentialBroker({ command: ["node", echoBroker()] });
    const seen = await broker.saveItem({ itemId: "abc", title: "GitHub" });
    expect(seen.id).toBe("save-item --item-id abc --title GitHub");
    expect(seen.id).not.toContain("--password-stdin");
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
  function saveItem(args: string[], password: string): { stdout: string; item: unknown } {
    const outPath = path.join(tmp("domo-item-"), "item.json");
    const stdout = execFileSync(
      "python3",
      ["-m", "seed_vault_broker", "save-item", ...args],
      {
        cwd: brokerDir,
        input: password,
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
    const { stdout, item } = saveItem(
      ["--title", "GitHub", "--username", "me@example.com", "--url", "https://github.com", "--password-stdin"],
      "hunter2",
    );
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
    expect(() => saveItem(["--title", "Nowhere", "--password-stdin"], "hunter2")).toThrow(
      /at least one site URL/,
    );
  });
});
