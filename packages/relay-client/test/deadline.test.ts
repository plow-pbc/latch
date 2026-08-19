/**
 * The timeout contract this Mac shares with the relay.
 *
 * The relay lives in another repository and owns the exchange deadline; this
 * side owns the budget that has to fit inside it. Both halves are pinned here
 * because getting them out of step is invisible until an agent is already
 * waiting on a response nobody will deliver.
 */
import { describe, expect, it } from "vitest";
import { Connection } from "@domo/transport";
import { RelayClient } from "../src/client.js";
import {
  DEFERRABLE_BUDGET_MS,
  deferrableBudgetMs,
  EXCHANGE_DEADLINE_FIELD,
  FRAME_RESPONSE,
  FRAME_RESPONSE_ACK,
  isResponseAckFrame,
  LEGACY_CALL_BUDGET_MS,
  LEGACY_EXCHANGE_DEADLINE_MS,
  MIN_DELIVERY_MARGIN_MS,
  RELAY_EXCHANGE_DEADLINE_MS,
} from "../src/wire.js";

describe("the shared timeout contract", () => {
  it("is twenty-five seconds of exchange, fifteen of budget, ten of margin", () => {
    expect(RELAY_EXCHANGE_DEADLINE_MS).toBe(25_000);
    expect(DEFERRABLE_BUDGET_MS).toBe(15_000);
    expect(MIN_DELIVERY_MARGIN_MS).toBe(10_000);
    // The three are one contract, not three numbers: what is left after the
    // budget IS the delivery margin.
    expect(RELAY_EXCHANGE_DEADLINE_MS - DEFERRABLE_BUDGET_MS).toBe(MIN_DELIVERY_MARGIN_MS);
  });

  it("takes the long budget only once the relay advertises the long deadline", () => {
    expect(deferrableBudgetMs(RELAY_EXCHANGE_DEADLINE_MS)).toBe(DEFERRABLE_BUDGET_MS);
    expect(deferrableBudgetMs(30_000)).toBe(DEFERRABLE_BUDGET_MS);
    // One millisecond short is short.
    expect(deferrableBudgetMs(RELAY_EXCHANGE_DEADLINE_MS - 1)).toBe(LEGACY_CALL_BUDGET_MS);
  });

  it("keeps the old budget when the relay advertises nothing", () => {
    // Relay-first rollout: a new desktop against an old relay must behave
    // exactly as the old desktop did, not assume the deadline it wants.
    expect(deferrableBudgetMs(undefined)).toBe(LEGACY_CALL_BUDGET_MS);
    expect(deferrableBudgetMs(null)).toBe(LEGACY_CALL_BUDGET_MS);
    expect(deferrableBudgetMs("25000")).toBe(LEGACY_CALL_BUDGET_MS);
    expect(deferrableBudgetMs(Number.NaN)).toBe(LEGACY_CALL_BUDGET_MS);
    expect(deferrableBudgetMs(0)).toBe(LEGACY_CALL_BUDGET_MS);
    expect(deferrableBudgetMs(LEGACY_EXCHANGE_DEADLINE_MS)).toBe(LEGACY_CALL_BUDGET_MS);
  });

  it("never configures a budget that eats its own delivery margin", () => {
    // A budget with less than ten seconds behind it produces handles the relay
    // has already stopped waiting for.
    for (const deadline of [30_000, 25_000, 20_000, 16_000, 12_000, 10_000, 1_000]) {
      expect(deferrableBudgetMs(deadline)).toBeLessThanOrEqual(
        Math.max(0, deadline - MIN_DELIVERY_MARGIN_MS),
      );
    }
    expect(deferrableBudgetMs(16_000)).toBe(6_000);
    expect(deferrableBudgetMs(1_000)).toBe(0);
  });
});

/** A socket that records what the client sends and can push frames back. */
function fakeConn(): Connection & { sent: Record<string, unknown>[] } {
  const conn = {
    onLine: null as ((line: Buffer) => void) | null,
    onClose: null as (() => void) | null,
    sent: [] as Record<string, unknown>[],
    startReading() {},
    sendLine(line: Buffer) {
      conn.sent.push(JSON.parse(line.toString("utf8")) as Record<string, unknown>);
    },
    close() {},
  };
  return conn as unknown as Connection & { sent: Record<string, unknown>[] };
}

/** Start a client against `conn` and drive the handshake to `auth.ok`. */
async function handshake(
  conn: Connection & { sent: Record<string, unknown>[] },
  authOk: Record<string, unknown>,
  options: Partial<ConstructorParameters<typeof RelayClient>[0]> = {},
): Promise<RelayClient> {
  const client = new RelayClient({
    url: "ws://relay.invalid/relay",
    credential: "plow_sk_test",
    serve: async () => new Response(JSON.stringify({ ok: true })),
    dial: () => ({ connect: async () => conn }),
    ...options,
  });
  await client.start();
  const push = (frame: unknown) =>
    (conn as unknown as { onLine: (line: Buffer) => void }).onLine(
      Buffer.from(JSON.stringify(frame), "utf8"),
    );
  push({ type: "auth.challenge" });
  push({ type: "auth.ok", ...authOk });
  return client;
}

describe("the budget the client adopts from a handshake", () => {
  it("takes the long budget from a relay that advertises the long deadline", async () => {
    const conn = fakeConn();
    const seen: Array<[number, number]> = [];
    const client = await handshake(
      conn,
      { [EXCHANGE_DEADLINE_FIELD]: RELAY_EXCHANGE_DEADLINE_MS },
      { onBudgetChange: (budget, deadline) => seen.push([budget, deadline]) },
    );
    expect(client.exchangeDeadlineMs).toBe(RELAY_EXCHANGE_DEADLINE_MS);
    expect(client.callBudgetMs).toBe(DEFERRABLE_BUDGET_MS);
    expect(seen).toEqual([[DEFERRABLE_BUDGET_MS, RELAY_EXCHANGE_DEADLINE_MS]]);
    await client.stop();
  });

  it("keeps the old budget against a relay that advertises nothing", async () => {
    const conn = fakeConn();
    const seen: Array<[number, number]> = [];
    const client = await handshake(
      conn,
      { ping_interval_ms: 15_000 },
      { onBudgetChange: (budget, deadline) => seen.push([budget, deadline]) },
    );
    expect(client.exchangeDeadlineMs).toBe(LEGACY_EXCHANGE_DEADLINE_MS);
    expect(client.callBudgetMs).toBe(LEGACY_CALL_BUDGET_MS);
    expect(seen).toEqual([[LEGACY_CALL_BUDGET_MS, LEGACY_EXCHANGE_DEADLINE_MS]]);
    await client.stop();
  });
});

describe("the relay's acknowledgement boundary", () => {
  const ackFrame = { type: FRAME_RESPONSE_ACK, rid: "R1" };

  it("recognises an acknowledgement frame and nothing else", () => {
    expect(isResponseAckFrame(ackFrame)).toBe(true);
    expect(isResponseAckFrame({ type: FRAME_RESPONSE_ACK })).toBe(false);
    expect(isResponseAckFrame({ type: FRAME_RESPONSE_ACK, rid: "" })).toBe(false);
    expect(isResponseAckFrame({ type: FRAME_RESPONSE, rid: "R1" })).toBe(false);
    expect(isResponseAckFrame(null)).toBe(false);
  });

  it("reports an acknowledgement only for a rid it actually answered", async () => {
    const conn = fakeConn();
    const acked: string[] = [];
    const client = await handshake(
      conn,
      { [EXCHANGE_DEADLINE_FIELD]: RELAY_EXCHANGE_DEADLINE_MS },
      { onResponseAck: (rid) => acked.push(rid) },
    );
    const push = (frame: unknown) =>
      (conn as unknown as { onLine: (line: Buffer) => void }).onLine(
        Buffer.from(JSON.stringify(frame), "utf8"),
      );

    // An ack before we have answered anything is not evidence of our delivery.
    push(ackFrame);
    expect(acked).toEqual([]);

    push({
      type: "relay.request",
      rid: "R1",
      method: "POST",
      path: "/mcp",
      headers: {},
      body: null,
    });
    await new Promise((r) => setImmediate(r));
    expect(conn.sent.some((f) => f.type === FRAME_RESPONSE && f.rid === "R1")).toBe(true);
    // Answering is not the same as the relay matching it to a waiting exchange.
    expect(acked).toEqual([]);

    push(ackFrame);
    expect(acked).toEqual(["R1"]);

    // Once matched, a repeat is not a second delivery.
    push(ackFrame);
    expect(acked).toEqual(["R1"]);
    await client.stop();
  });

  it("treats a lost socket as delivery unknown, not delivery confirmed", async () => {
    const conn = fakeConn();
    const acked: string[] = [];
    const client = await handshake(
      conn,
      { [EXCHANGE_DEADLINE_FIELD]: RELAY_EXCHANGE_DEADLINE_MS },
      { onResponseAck: (rid) => acked.push(rid), dial: () => ({ connect: async () => conn }) },
    );
    const push = (frame: unknown) =>
      (conn as unknown as { onLine: (line: Buffer) => void }).onLine(
        Buffer.from(JSON.stringify(frame), "utf8"),
      );

    push({
      type: "relay.request",
      rid: "R9",
      method: "POST",
      path: "/mcp",
      headers: {},
      body: null,
    });
    await new Promise((r) => setImmediate(r));
    await client.stop();
    (conn as unknown as { onClose: (() => void) | null }).onClose?.();

    // A reconnected relay's stale ack must not resolve a rid whose response
    // died with the old socket.
    push({ type: FRAME_RESPONSE_ACK, rid: "R9" });
    expect(acked).toEqual([]);
  });
});
