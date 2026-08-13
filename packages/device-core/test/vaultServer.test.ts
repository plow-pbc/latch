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
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { VaultServer } from "@domo/device-core";

/** A port nobody is on, asked for at the moment it is needed: fixed numbers
 *  collide with whatever a previous failed run left behind. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** One connect attempt. `onTimeout` decides what an ambiguous socket means:
 *  a probe asking "is it up?" and one asking "is it gone?" want opposite
 *  answers, and that is the only thing separating the two callers below. */
function portAnswers(port: number, { timeoutMs = 1_000, onTimeout = false } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(onTimeout));
  });
}

/** True once nothing answers on the port; false if something still does. */
async function portFreesUp(port: number, withinMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    // A socket that hangs is still something holding the port.
    if (!(await portAnswers(port, { timeoutMs: 500, onTimeout: true }))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const servers: VaultServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

/**
 * A stand-in vaultwarden. `registers` serves HTTPS with the cert the server
 * minted and accepts an account; `silent` takes the connection and never speaks
 * TLS, which is how a half-started vault behaves.
 */
function stubVault(dir: string, mode: "registers" | "silent", registerDelayMs = 0): { binary: string; envLog: string; hits: string } {
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
    // Honours the flag, like the real one: a vault started with registration
    // closed refuses to make accounts, which is the property under test.
    if (req.url.includes("/register") && process.env.SIGNUPS_ALLOWED !== "true") {
      req.once("end", () => { res.writeHead(400); res.end("{}"); });
      return;
    }
    req.once("end", () => setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    }, ${JSON.stringify(registerDelayMs)}));
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

async function makeServer(mode: "registers" | "silent" = "registers", registerDelayMs = 0) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-vault-"));
  const { binary, envLog, hits } = stubVault(dir, mode, registerDelayMs);
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
  /** Ask the running vault to make an account; returns its HTTP status. */
  const register = (p: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = https.request(
        `https://127.0.0.1:${p}/identity/accounts/register`,
        { method: "POST", ca: fs.readFileSync(server.certPath) },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.once("error", reject);
      req.end("{}");
    });
  return {
    server,
    port,
    launches: () => lines(envLog),
    signups: () => lines(envLog).map((l) => (JSON.parse(l) as Record<string, string>).SIGNUPS_ALLOWED),
    envOf: (nth: number) => JSON.parse(lines(envLog).at(nth)!) as Record<string, string>,
    registrations: () => lines(hits),
    register,
  };
}

describe("the vault process", () => {
  it("makes every concurrent caller wait for the account, not just for the process", async () => {
    const { server, launches, registrations } = await makeServer();

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
    expect(registrations(), "one account, made once").toEqual(["/identity/accounts/register"]);
    expect(launches(), "one vault, not one per caller").toHaveLength(1);

    await server.start(); // already up: no relaunch, no second account
    expect(launches()).toHaveLength(1);
    expect(registrations()).toHaveLength(1);
  }, 30_000);

  it("retries when the account never got made, instead of reporting itself started", async () => {
    // The port answers but the stub is not a vault, so creating the account
    // fails. A live process with no account in it is NOT started: the next
    // caller would otherwise run its broker against an empty vault.
    const { server, launches } = await makeServer("silent");

    await expect(server.start()).rejects.toThrow();
    await expect(server.start()).rejects.toThrow();

    const found = launches();
    expect(found, "the second call tried again rather than believing the first").toHaveLength(2);
    // Two 10s request timeouts: the stub takes the connection and never speaks
    // TLS, which is also what proves `send()` gives up rather than hanging the
    // credential call behind it. Explicit ceiling so load cannot flake it.
  }, 60_000);

  it("stopped mid-startup does not come back claiming it started", async () => {
    // Covers the reachable half: a stop() during startup makes start() reject,
    // and leaves nothing behind that would let the NEXT caller resolve instantly
    // off a stale `ready`. (`launch()`'s post-bootstrap identity check guards a
    // narrower race still — stop() landing while a registration that then
    // SUCCEEDS is in flight — which needs sub-second timing to hit and is left
    // uncovered rather than made flaky.)
    const { server, launches } = await makeServer("registers", 3_000);
    const starting = server.start();
    setTimeout(() => server.stop(), 900);

    await expect(starting, "a vault that was stopped did not start").rejects.toThrow();
    await server.start();
    expect(launches(), "the next caller really relaunched").toHaveLength(2);
    expect(server.account, "and it made the account this time").not.toBeNull();
  }, 30_000);

  it("replaces a predecessor without orphaning it, and the replacement makes no second account", async () => {
    // The failure this guards: the first process exits AFTER its replacement is
    // up, its `exit` handler clears the shared handle, and the live detached
    // vaultwarden is left holding the port with nothing tracking it.
    const { server, port, launches, signups, register } = await makeServer();
    await server.start();
    server.stop(); // SIGTERM; the exit event lands a tick or two later
    await server.start();
    await new Promise((r) => setTimeout(r, 750)); // let the first one's exit arrive

    expect(launches(), "the replacement really is a second process").toHaveLength(2);
    expect(
      await portAnswers(port),
      "the replacement is actually serving, so the next assertions mean something",
    ).toBe(true);

    // The account already existed when this one started, so registration is
    // closed — the property that outlives the deleted signup-closing lifecycle.
    expect(signups(), "open to make the account, closed once it exists").toEqual(["true", "false"]);
    expect(
      await register(port),
      "the vault that inherited the account refuses to make another",
    ).toBe(400);

    // The whole point: `stop()` can still reach the live one. If the dead
    // predecessor had cleared the handle, this would kill nothing and the port
    // would stay held by a process nothing tracks.
    server.stop();
    expect(await portFreesUp(port), "nothing was left holding the port").toBe(true);
  }, 30_000);

  it("is never given the vault variables it has no use for", async () => {
    process.env.DOMO_VAULT_TOKEN = "bootstrap-token";
    process.env.SEED_VAULT_PASSWORD = "the-account-password";
    try {
      const { server, port, envOf } = await makeServer();
      await server.start();

      const seen = envOf(-1); // the process still running once startup settled
      const leaked = Object.keys(seen).filter(
        (k) => k.startsWith("SEED_VAULT_") || k.startsWith("DOMO_VAULT_"),
      );
      expect(leaked, "the vault server is not where these belong").toEqual([]);
      expect(seen.ROCKET_PORT, "what it does need still arrives").toBe(String(port));
    } finally {
      delete process.env.DOMO_VAULT_TOKEN;
      delete process.env.SEED_VAULT_PASSWORD;
    }
  });
});
