/**
 * A stand-in for the local vault: a TLS listener presenting a self-signed
 * certificate, the way `VaultServer` mints its own.
 *
 * Shared because the vault's failures are reached through its certificate — a
 * stranger holding the port, a server that stops mid-answer — and a second copy
 * of this setup would drift from the first.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

/** A self-signed pair, the way the vault mints its own. */
export function mint(dir: string, name: string): { cert: string; key: string } {
  const cert = path.join(dir, `${name}.pem`);
  const key = path.join(dir, `${name}.key`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  return { cert, key };
}

/**
 * Serve `pair` on a loopback port, answering each request with `answer`.
 *
 * `hits` counts the requests that arrived — how a caller tells which of two
 * servers was reached. Identity cases never get that far: they only need the
 * handshake.
 */
export function listen(
  pair: { cert: string; key: string },
  answer: (sock: tls.TLSSocket) => void = (sock) => {
    const body = JSON.stringify({ data: [] }); // an empty listing: a healthy vault
    sock.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
  },
): Promise<tls.Server & { port: number; hits: number }> {
  const server = Object.assign(
    tls.createServer({ cert: fs.readFileSync(pair.cert), key: fs.readFileSync(pair.key) }),
    { port: 0, hits: 0 },
  );
  server.on("secureConnection", (sock) => sock.once("data", () => (server.hits++, answer(sock))));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      server.port = (server.address() as { port: number }).port;
      resolve(server);
    });
  });
}

/**
 * A listener that accepts the connection and never speaks TLS — a vault that
 * has bound its port but is not serving on it yet.
 */
export function listenSilently(): Promise<net.Server & { port: number; hits: number }> {
  const server = Object.assign(net.createServer(), { port: 0, hits: 0 });
  server.on("connection", () => server.hits++);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      server.port = (server.address() as { port: number }).port;
      resolve(server);
    });
  });
}
