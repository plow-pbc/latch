/**
 * The wire contract's pure parts.
 *
 * These checks lived in `relayClient.test.ts`, which was deleted with the
 * stand-in relay. They never needed it: `stripHopByHop` and `isRequestFrame`
 * are functions over plain objects, and the policy that removed the stand-in
 * keeps exactly this kind of test. Re-homed here so the header rules stay
 * pinned — they are cross-repo interface, and `Host` in particular is a
 * security property, not a formatting preference.
 */
import { describe, expect, it } from "vitest";
import { CALL_BUDGET_MS } from "@domo/mcp-server";
import {
  FRAME_REQUEST,
  HOP_BY_HOP,
  isRequestFrame,
  RELAY_TIMEOUT_MS,
  stripHopByHop,
} from "../src/wire.js";

describe("stripHopByHop", () => {
  it("strips hop-by-hop headers in both directions, but keeps Host", () => {
    const stripped = stripHopByHop({
      "content-type": "application/json",
      "Content-Length": "12",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      Host: "api.plow.co",
      "mcp-method": "tools/list",
    });
    expect(stripped).toEqual({
      "content-type": "application/json",
      // Host is END-TO-END: it names the authority the agent addressed, and
      // dropping it would leave this Mac validating a fabricated one.
      Host: "api.plow.co",
      "mcp-method": "tools/list",
    });
    expect(HOP_BY_HOP.has("host")).toBe(false);
  });

  it("matches the header name however it was cased on the wire", () => {
    expect(stripHopByHop({ "Transfer-Encoding": "chunked", TE: "trailers" })).toEqual({});
  });

  it("preserves the casing of the headers it keeps", () => {
    // The bag is handed to `new Headers`, which lowercases — but nothing here
    // should be rewriting names on the way past.
    expect(stripHopByHop({ "MCP-Method": "tools/call" })).toEqual({ "MCP-Method": "tools/call" });
  });

  it("survives a frame with no headers at all", () => {
    expect(stripHopByHop(undefined as unknown as Record<string, string>)).toEqual({});
  });
});

describe("the relay's ceiling and this Mac's budget", () => {
  it("leaves enough of the exchange for delivery after the budget is spent", () => {
    // What is left is not slack: registering the handle, framing the response,
    // and the relay matching it to the exchange still waiting all have to fit.
    // A floor, expressed here rather than exported — it is our sizing choice,
    // not something a relay implementation has to agree with.
    const DELIVERY_MARGIN_MS = 10_000;
    expect(RELAY_TIMEOUT_MS - CALL_BUDGET_MS).toBeGreaterThanOrEqual(DELIVERY_MARGIN_MS);
  });
});

describe("isRequestFrame", () => {
  const frame = { type: FRAME_REQUEST, rid: "r1", method: "POST", path: "/mcp" };

  it("accepts a frame this Mac can actually serve", () => {
    expect(isRequestFrame(frame)).toBe(true);
  });

  it("rejects anything missing what serving it requires", () => {
    // A relay written by someone else is on the other end of this; every one of
    // these arriving is a wire-contract disagreement, not a crash.
    expect(isRequestFrame({ ...frame, type: "relay.response" })).toBe(false);
    expect(isRequestFrame({ ...frame, rid: "" })).toBe(false);
    expect(isRequestFrame({ ...frame, rid: undefined })).toBe(false);
    expect(isRequestFrame({ ...frame, method: 1 })).toBe(false);
    expect(isRequestFrame({ ...frame, path: undefined })).toBe(false);
    expect(isRequestFrame(null)).toBe(false);
    expect(isRequestFrame("relay.request")).toBe(false);
  });
});
