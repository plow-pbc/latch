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

function listen(pair: { cert: string; key: string }): Promise<tls.Server & { port: number }> {
  const server = tls.createServer({
    cert: fs.readFileSync(pair.cert),
    key: fs.readFileSync(pair.key),
  }, (sock) => sock.end());
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve(Object.assign(server, { port }));
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
