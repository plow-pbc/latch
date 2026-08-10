/**
 * WebSocket transport: ws:// loopback, wss:// with a self-signed cert +
 * SPKI pinning (good pin connects, bad pin fails closed, no-trust fails
 * against the CA store) — mirroring the Swift PinningTests posture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jv } from "@domo/protocol";
import {
  Connection,
  LineRPC,
  SPKIPinningEvaluator,
  WebSocketDialer,
  WebSocketListener,
  spkiPinOfDerCertificate,
} from "@domo/transport";

let dir: string;
let certPath: string;
let keyPath: string;
let pin: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-ws-"));
  certPath = path.join(dir, "cert.pem");
  keyPath = path.join(dir, "key.pem");
  execSync(
    `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
      `-keyout ${keyPath} -out ${certPath} -days 2 -nodes -subj /CN=127.0.0.1 2>/dev/null`,
  );
  // Pin via the canonical OpenSSL recipe — proves our extractor matches the
  // interoperable definition (the same one the Swift SPKIHash implements).
  pin = execSync(
    `openssl x509 -in ${certPath} -pubkey -noout | openssl pkey -pubin -outform der | ` +
      `openssl dgst -sha256 -binary | openssl base64`,
  )
    .toString()
    .trim();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function echoListener(listener: WebSocketListener): void {
  listener.onConnection = (conn: Connection) => {
    const rpc = new LineRPC(conn);
    rpc.register("echo", async (params) => params);
  };
}

describe("WebSocket transport", () => {
  it("SPKI extractor matches the OpenSSL recipe", () => {
    expect(spkiPinOfDerCertificate(fs.readFileSync(certPath))).toBe(pin);
  });

  it("plain ws:// loopback round-trip", async () => {
    const listener = new WebSocketListener(0);
    echoListener(listener);
    await listener.start();
    try {
      const conn = await new WebSocketDialer(`ws://127.0.0.1:${listener.actualPort}/`).connect();
      const rpc = new LineRPC(conn);
      rpc.start();
      const result = await rpc.call("echo", { hello: "ws" });
      expect(jv(result).get("hello").str).toBe("ws");
      rpc.close();
    } finally {
      listener.stop();
    }
  });

  it("wss:// with the correct SPKI pin connects", async () => {
    const listener = new WebSocketListener(0, { certPath, keyPath });
    echoListener(listener);
    await listener.start();
    try {
      const trust = new SPKIPinningEvaluator([{ sha256Base64: pin }]);
      const conn = await new WebSocketDialer(
        `wss://127.0.0.1:${listener.actualPort}/`,
        trust,
      ).connect();
      const rpc = new LineRPC(conn);
      rpc.start();
      const result = await rpc.call("echo", { secure: true });
      expect(jv(result).get("secure").bool).toBe(true);
      rpc.close();
    } finally {
      listener.stop();
    }
  });

  it("wss:// with a wrong pin fails closed", async () => {
    const listener = new WebSocketListener(0, { certPath, keyPath });
    echoListener(listener);
    await listener.start();
    try {
      const trust = new SPKIPinningEvaluator([
        { sha256Base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
      ]);
      await expect(
        new WebSocketDialer(`wss://127.0.0.1:${listener.actualPort}/`, trust, 5).connect(),
      ).rejects.toThrow(/pin mismatch|websocket connect failed/);
    } finally {
      listener.stop();
    }
  });

  it("wss:// self-signed without a pin fails CA validation", async () => {
    const listener = new WebSocketListener(0, { certPath, keyPath });
    echoListener(listener);
    await listener.start();
    try {
      await expect(
        new WebSocketDialer(`wss://127.0.0.1:${listener.actualPort}/`, null, 5).connect(),
      ).rejects.toThrow(/websocket connect failed/);
    } finally {
      listener.stop();
    }
  });
});
