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

/** A stand-in vaultwarden: appends its env, then answers on ROCKET_PORT. */
function stubVault(dir: string): { binary: string; envLog: string } {
  const envLog = path.join(dir, "env.jsonl");
  const binary = path.join(dir, "stub-vaultwarden");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs"), net = require("node:net");
fs.appendFileSync(${JSON.stringify(envLog)}, JSON.stringify(process.env) + "\\n");
net.createServer(() => {}).listen(Number(process.env.ROCKET_PORT), "127.0.0.1");
`,
    { mode: 0o755 },
  );
  return { binary, envLog };
}

/** `person` set means bootstrap runs — and against this stub, fails. */
function makeServer(port: number, person?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-vault-"));
  const { binary, envLog } = stubVault(dir);
  const server = new VaultServer({
    binary,
    webVaultDir: dir,
    dataDir: path.join(dir, "data"),
    port,
    person,
    startTimeoutMs: 15_000,
  });
  servers.push(server);
  return { server, envLog };
}

describe("the vault process", () => {
  it("starts once no matter how many callers ask at the same time", async () => {
    const { server, envLog } = makeServer(18231);

    // Every credential lookup calls start(); a cold launch has several in
    // flight at once. All of them must wait for the one startup.
    await Promise.all([server.start(), server.start(), server.start()]);
    await server.start();

    const launches = fs.readFileSync(envLog, "utf8").trim().split("\n");
    expect(launches, "one vault, not one per caller").toHaveLength(1);
  });

  it("retries when the account never got made, instead of reporting itself started", async () => {
    // The port answers but the stub is not a vault, so creating the account
    // fails. A live process with no account in it is NOT started: the next
    // caller would otherwise run its broker against an empty vault.
    const { server, envLog } = makeServer(18233, "someone@example.com");

    await expect(server.start()).rejects.toThrow();
    await expect(server.start()).rejects.toThrow();

    const launches = fs.readFileSync(envLog, "utf8").trim().split("\n");
    expect(launches, "the second call tried again rather than believing the first").toHaveLength(2);
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
