/**
 * Unix-socket transport + LineRPC behavior, mirroring the Swift
 * ConnectionTests: bidirectional calls, unknown-method errors, and
 * close-fails-pending.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jv } from "@domo/protocol";
import {
  Connection,
  LineRPC,
  RPCError,
  SocketServer,
  UnixSocketDialer,
} from "@domo/transport";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempSock(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "t.sock");
}

async function pair(): Promise<{ server: LineRPC; client: LineRPC }> {
  const sockPath = tempSock();
  const listener = new SocketServer(sockPath);
  cleanups.push(() => listener.stop());
  const serverRPC = new Promise<LineRPC>((resolve) => {
    listener.onConnection = (conn: Connection) => resolve(new LineRPC(conn));
  });
  await listener.start();
  const clientConn = await new UnixSocketDialer(sockPath).connect();
  const client = new LineRPC(clientConn);
  client.start();
  return { server: await serverRPC, client };
}

describe("LineRPC over Unix sockets", () => {
  it("bidirectional request/response", async () => {
    const { server, client } = await pair();
    server.register("sum", async (params) => {
      const a = jv(params).get("a").num ?? 0;
      const b = jv(params).get("b").num ?? 0;
      return { total: a + b };
    });
    client.register("ping_back", async () => ({ pong: true }));

    const result = await client.call("sum", { a: 2, b: 40 });
    expect(jv(result).get("total").num).toBe(42);

    // The server can call the client too (symmetric RPC).
    const back = await server.call("ping_back", {});
    expect(jv(back).get("pong").bool).toBe(true);
  });

  it("unknown method returns an error", async () => {
    const { client } = await pair();
    await expect(client.call("nope", {})).rejects.toThrow("unknown method nope");
  });

  it("handler errors propagate as RPC errors", async () => {
    const { server, client } = await pair();
    server.register("boom", async () => {
      throw new Error("kaboom");
    });
    await expect(client.call("boom", {})).rejects.toThrow("kaboom");
  });

  it("close fails pending calls", async () => {
    const { server, client } = await pair();
    server.register("hang", () => new Promise(() => {}));
    const pending = client.call("hang", {}, 30);
    // Give the request a beat to be in flight, then drop the connection.
    await new Promise((r) => setTimeout(r, 50));
    client.close();
    await expect(pending).rejects.toThrow(RPCError);
  });

  it("large lines round-trip intact", async () => {
    const { server, client } = await pair();
    server.register("echo", async (params) => params);
    const big = "x".repeat(500_000);
    const result = await client.call("echo", { blob: big });
    expect(jv(result).get("blob").str).toBe(big);
  });
});
