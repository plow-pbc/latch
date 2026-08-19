/**
 * The session follows the vault, not the address it signed in on.
 *
 * A vault that exits and comes back while a stranger holds its old port serves
 * on the next free one. The client caches its signed-in session, so a session
 * holding the old address would send the owner's next action to the stranger —
 * which is the "self signed certificate" failure this path exists to prevent,
 * reached the long way round.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, describe, expect, it } from "vitest";
import { VaultClient, type OwnVault } from "../src/browser/vaultClient.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-move-"));
const cert = path.join(dir, "cert.pem");
const key = path.join(dir, "key.pem");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
  "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
], { stdio: ["ignore", "ignore", "pipe"] });

/** A vault that answers an empty listing and counts who asked. */
function vault(): Promise<tls.Server & { port: number; hits: number }> {
  const server = Object.assign(
    tls.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }),
    { port: 0, hits: 0 },
  );
  server.on("secureConnection", (sock) => {
    sock.once("data", () => {
      server.hits++;
      const body = JSON.stringify({ data: [] });
      sock.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      server.port = (server.address() as { port: number }).port;
      resolve(server);
    });
  });
}

const servers: tls.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

describe("VaultClient.open", () => {
  it("sends the next action to where the vault is now, not where it signed in", async () => {
    const [signedInOn, movedTo] = await Promise.all([vault(), vault()]);
    servers.push(signedInOn, movedTo);

    // The server has already moved by the time the client asks it to start —
    // exactly what VaultServer.selectPort does when a stranger holds the port.
    const server: OwnVault = {
      url: `https://127.0.0.1:${signedInOn.port}`,
      certPath: cert,
      account: { email: "a@b.c", password: "x" },
      async start() {
        (this as { url: string }).url = `https://127.0.0.1:${movedTo.port}`;
      },
    };

    const client = new VaultClient(server);
    // A session already signed in on the old address. Seeded rather than signed
    // in for real: the address it carries is the whole subject here.
    (client as unknown as { session: unknown }).session = {
      http: { url: `https://127.0.0.1:${signedInOn.port}`, ca: fs.readFileSync(cert), token: "t" },
      key: { enc: Buffer.alloc(32), mac: Buffer.alloc(32) },
    };

    expect(await client.list()).toEqual([]);
    expect(movedTo.hits).toBe(1);
    expect(signedInOn.hits).toBe(0);
  });
});
