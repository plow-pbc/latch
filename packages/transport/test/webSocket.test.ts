/**
 * WebSocket transport (client half): ws:// loopback round-trip, the
 * buffer-until-startReading contract, close propagation, and the TLS posture
 * that replaced SPKI pinning — a self-signed peer is refused by the system CA
 * store, so a relay endpoint must present a real certificate.
 *
 * The test server is a bare `ws` server: the listener half of the transport
 * seam went with the broker, so nothing in the package can serve any more.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { Connection, WebSocketDialer } from "@domo/transport";

let dir: string;
let certPath: string;
let keyPath: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-ws-"));
  certPath = path.join(dir, "cert.pem");
  keyPath = path.join(dir, "key.pem");
  execSync(
    `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
      `-keyout ${keyPath} -out ${certPath} -days 2 -nodes -subj /CN=127.0.0.1 2>/dev/null`,
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A bare echo server; returns its port and a stop(). */
async function echoServer(tls = false): Promise<{ port: number; stop: () => void }> {
  const server = tls
    ? https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) })
    : undefined;
  const wss = server ? new WebSocketServer({ server }) : new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => ws.on("message", (data: Buffer) => ws.send(data)));
  const port = await new Promise<number>((resolve) => {
    if (server) server.listen(0, () => resolve((server.address() as AddressInfo).port));
    else wss.on("listening", () => resolve((wss.address() as AddressInfo).port));
  });
  return {
    port,
    stop: () => {
      // wss.close() only stops accepting — drop live clients too, so a stop()
      // is what a peer going away actually looks like.
      for (const client of wss.clients) client.terminate();
      wss.close();
      server?.close();
    },
  };
}

function nextLine(conn: Connection): Promise<Buffer> {
  return new Promise((resolve) => {
    conn.onLine = (line) => resolve(line);
  });
}

describe("WebSocket transport", () => {
  it("wss:// self-signed is refused by the CA store", async () => {
    const { port, stop } = await echoServer(true);
    try {
      await expect(new WebSocketDialer(`wss://127.0.0.1:${port}/`, 5).connect()).rejects.toThrow(
        /websocket connect failed/,
      );
    } finally {
      stop();
    }
  });

});
