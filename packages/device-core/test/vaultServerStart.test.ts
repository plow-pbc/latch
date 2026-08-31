/**
 * When is the vault up, and who is on its port.
 *
 * Both answers used to be wrong in the same way: the port being bound was read
 * as the vault serving, and a vault of ours that had bound but not yet answered
 * was read as somebody else's. The first handed the owner's first read a server
 * that accepts and then says nothing — the Vault tab that never opened. The
 * second walked past our own booting vault and spawned a second vaultwarden on
 * this same data directory (plow-pbc/latch#193).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { servesCertificate, VaultServer } from "../src/browser/vaultServer.js";
import { listenSilently } from "./vaultTestServer.js";

const dirs: string[] = [];
const servers: { close: () => void }[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-start-"));
  dirs.push(dir);
  return dir;
}

/** An executable standing in for `vaultwarden`, running `body` under this Node. */
function fakeBinary(dir: string, name: string, body: string): string {
  const js = path.join(dir, `${name}.js`);
  fs.writeFileSync(js, body);
  const sh = path.join(dir, name);
  fs.writeFileSync(sh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)}\n`, { mode: 0o755 });
  return sh;
}

/**
 * A vault that binds its port at once and only serves TLS on it a while later —
 * what the real vaultwarden does, on a smaller clock.
 */
const BINDS_THEN_SERVES = `
const fs = require("node:fs"), net = require("node:net"), tls = require("node:tls");
const port = Number(process.env.ROCKET_PORT);
const [, cert, key] = /certs="([^"]+)",key="([^"]+)"/.exec(process.env.ROCKET_TLS);
const ctx = { cert: fs.readFileSync(cert), key: fs.readFileSync(key), isServer: true };
// One listener throughout, so the port is bound from the first moment. Before
// the delay is up it accepts and says nothing — bound, not serving.
let serving = false;
setTimeout(() => { serving = true; }, Number(process.env.FAKE_SERVE_DELAY_MS));
net.createServer((sock) => {
  if (!serving) return;
  const t = new tls.TLSSocket(sock, ctx);
  t.on("error", () => {});
  t.on("data", () => t.end("HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\n\\r\\n"));
}).listen(port, "127.0.0.1");
`;

describe("VaultServer.start", () => {
  it("waits for the vault to serve, not merely to bind", async () => {
    const dir = workspace();
    const vault = new VaultServer({
      binary: fakeBinary(dir, "slow-vault", BINDS_THEN_SERVES),
      webVaultDir: dir,
      dataDir: path.join(dir, "data"),
      port: 18222,
    });
    servers.push({ close: () => vault.stop() });
    process.env.FAKE_SERVE_DELAY_MS = "1200";

    await vault.start();

    // The claim: once `start()` resolves, a read placed right now reaches a
    // vault that answers. Waiting on the bare TCP connect returned here at
    // roughly time zero, and this is "silent".
    const port = Number(new URL(vault.url).port);
    expect(await servesCertificate(port, vault.certPath)).toBe("ours");
  }, 30_000);

  it("refuses to spawn beside a server that will not say who it is", async () => {
    const dir = workspace();
    const held = await listenSilently();
    servers.push(held);

    const spawned = path.join(dir, "spawned");
    const vault = new VaultServer({
      binary: fakeBinary(dir, "should-not-run", `require("node:fs").writeFileSync(${JSON.stringify(spawned)}, "");`),
      webVaultDir: dir,
      dataDir: path.join(dir, "data"),
      port: held.port,
      identifyTimeoutMs: 500,
    });
    servers.push({ close: () => vault.stop() });

    // Silence is not "somebody else's". If that server is our own vault still
    // booting, the second one this used to spawn would share its SQLite file.
    await expect(vault.start()).rejects.toThrow(/without answering/);
    expect(fs.existsSync(spawned)).toBe(false);
  }, 30_000);
});
