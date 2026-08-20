/**
 * Whose vault is on the port.
 *
 * A vault server outlives a hard quit — it runs in its own process group so
 * the app can kill the group, and an app that is killed never gets to. The
 * port being open therefore says nothing about whose vault answers on it, and
 * trusting it is what reached one owner as "self signed certificate": their
 * new install talked to an old install's server with its own certificate.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, describe, expect, it } from "vitest";
import { servesCertificate } from "@domo/device-core";
import { VaultClient, type OwnVault } from "../src/browser/vaultClient.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-port-"));

/** A self-signed pair, the way the vault mints its own. */
function mint(name: string): { cert: string; key: string } {
  const cert = path.join(dir, `${name}.pem`);
  const key = path.join(dir, `${name}.key`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  return { cert, key };
}

const ours = mint("ours");
const stranger = mint("stranger");

function listen(pair: { cert: string; key: string }): Promise<tls.Server & { port: number; hits: number }> {
  const server = Object.assign(
    tls.createServer({ cert: fs.readFileSync(pair.cert), key: fs.readFileSync(pair.key) }),
    { port: 0, hits: 0 },
  );
  // An empty listing, to whoever asks. The identity cases never get this far —
  // they only need the handshake — but the relocation case below asks, and the
  // count is how it knows which vault was reached.
  server.on("secureConnection", (sock) => {
    sock.once("data", () => {
      server.hits++;
      const body = JSON.stringify({ data: [] });
      sock.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
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

describe("servesCertificate", () => {
  // The stranger is the old install still holding 8222 after its app went away.
  it.each([
    ["our own vault", ours, true],
    ["somebody else's vault on our port", stranger, false],
  ])("identifies %s", async (_name, pair, expected) => {
    const server = await listen(pair);
    servers.push(server);
    expect(await servesCertificate(server.port, ours.cert)).toBe(expected);
  });

  it("says no when nothing is listening", async () => {
    const server = await listen(ours);
    const port = server.port;
    await new Promise((r) => server.close(r));
    expect(await servesCertificate(port, ours.cert)).toBe(false);
  });
});

/**
 * The client half of the same incident: the server may move, and a session that
 * kept the address it signed in on would send the owner's next action to
 * whoever holds the old port.
 */
describe("VaultClient.open", () => {
  it("sends the next action to where the vault is now, not where it signed in", async () => {
    const [signedInOn, movedTo] = await Promise.all([listen(ours), listen(ours)]);
    servers.push(signedInOn, movedTo);

    // Moved by the time the client asks it to start — what `selectPort` does
    // when a stranger holds the port this vault had last time.
    const server: OwnVault = {
      url: `https://127.0.0.1:${signedInOn.port}`,
      certPath: ours.cert,
      account: { email: "a@b.c", password: "x" },
      async start() {
        (this as { url: string }).url = `https://127.0.0.1:${movedTo.port}`;
      },
    };

    const client = new VaultClient(server);
    // A session already signed in on the old address. Seeded rather than signed
    // in for real: the address it carries is the whole subject here.
    (client as unknown as { session: unknown }).session = {
      http: { url: server.url, ca: fs.readFileSync(ours.cert), token: "t" },
      key: { enc: Buffer.alloc(32), mac: Buffer.alloc(32) },
    };

    expect(await client.list()).toEqual([]);
    expect(movedTo.hits).toBe(1);
    expect(signedInOn.hits).toBe(0);
  });
});
