/**
 * The vault process itself: started once however many callers ask, and never
 * handed the vault variables it has no use for.
 *
 * A stub stands in for `vaultwarden`: it records the environment it was given,
 * counts how many times it was launched, and opens the port it was told to, so
 * `start()` completes exactly as it does against the real binary.
 */
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VaultServer } from "@domo/device-core";

const servers: VaultServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

/**
 * A stand-in vaultwarden. `registers` serves HTTPS with the cert the server
 * minted and accepts an account; `silent` takes the connection and never speaks
 * TLS, which is how a half-started vault behaves.
 */
function stubVault(dir: string, mode: "registers" | "silent"): { binary: string; envLog: string; hits: string } {
  const envLog = path.join(dir, "env.jsonl");
  const hits = path.join(dir, "register-hits.log");
  const serve =
    mode === "silent"
      ? `require("node:net").createServer(() => {}).listen(port, "127.0.0.1");`
      : `const tls = process.env.ROCKET_TLS.match(/certs="([^"]+)",key="([^"]+)"/);
require("node:https")
  .createServer({ cert: fs.readFileSync(tls[1]), key: fs.readFileSync(tls[2]) }, (req, res) => {
    fs.appendFileSync(${JSON.stringify(hits)}, req.url + "\\n");
    req.resume();
    req.once("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
  })
  .listen(port, "127.0.0.1");`;
  const binary = path.join(dir, "stub-vaultwarden");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(envLog)}, JSON.stringify(process.env) + "\\n");
const port = Number(process.env.ROCKET_PORT);
${serve}
`,
    { mode: 0o755 },
  );
  return { binary, envLog, hits };
}

function makeServer(port: number, mode: "registers" | "silent" = "registers") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-vault-"));
  const { binary, envLog, hits } = stubVault(dir, mode);
  const server = new VaultServer({
    binary,
    webVaultDir: dir,
    dataDir: path.join(dir, "data"),
    port,
    person: "someone@example.com",
    startTimeoutMs: 15_000,
  });
  servers.push(server);
  const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n") : []);
  return { server, launches: () => lines(envLog), registrations: () => lines(hits), envLog };
}

describe("the vault process", () => {
  it("makes every concurrent caller wait for the account, not just for the process", async () => {
    const { server, launches, registrations } = makeServer(18231);

    // Every credential lookup calls start(); a cold launch has several in
    // flight at once. What each one must NOT do is return as soon as a process
    // exists — the broker it is about to run needs the account, which is
    // created after that.
    const sawAccount = await Promise.all(
      [1, 2, 3].map(() => server.start().then(() => server.account !== null)),
    );

    expect(sawAccount, "every caller had an account by the time it resolved").toEqual([
      true,
      true,
      true,
    ]);
    expect(launches(), "one vault, not one per caller").toHaveLength(1);
    expect(registrations(), "one account, made once").toEqual(["/identity/accounts/register"]);

    await server.start(); // already up: no relaunch, no second account
    expect(launches()).toHaveLength(1);
    expect(registrations()).toHaveLength(1);
  }, 30_000);

  it("retries when the account never got made, instead of reporting itself started", async () => {
    // The port answers but the stub is not a vault, so creating the account
    // fails. A live process with no account in it is NOT started: the next
    // caller would otherwise run its broker against an empty vault.
    const { server, launches } = makeServer(18233, "silent");

    await expect(server.start()).rejects.toThrow();
    await expect(server.start()).rejects.toThrow();

    const found = launches();
    expect(found, "the second call tried again rather than believing the first").toHaveLength(2);
    // Two 10s request timeouts: the stub takes the connection and never speaks
    // TLS, which is also what proves `send()` gives up rather than hanging the
    // credential call behind it. Explicit ceiling so load cannot flake it.
  }, 60_000);

  it("is never given the vault variables it has no use for", async () => {
    process.env.DOMO_VAULT_TOKEN = "bootstrap-token";
    process.env.SEED_VAULT_PASSWORD = "the-account-password";
    try {
      const { server, envLog } = makeServer(18232);
      await server.start();

      const seen = JSON.parse(fs.readFileSync(envLog, "utf8").trim()) as Record<string, string>;
      const leaked = Object.keys(seen).filter(
        (k) => k.startsWith("SEED_VAULT_") || k.startsWith("DOMO_VAULT_"),
      );
      expect(leaked, "the vault server is not where these belong").toEqual([]);
      expect(seen.ROCKET_PORT, "what it does need still arrives").toBe("18232");
    } finally {
      delete process.env.DOMO_VAULT_TOKEN;
      delete process.env.SEED_VAULT_PASSWORD;
    }
  });
});
