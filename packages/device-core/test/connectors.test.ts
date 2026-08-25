import { describe, expect, it } from "vitest";
import { makeConnectorClient, ConnectorError, SlackAction } from "../src/connectors.js";

/**
 * The rejection a call produced — and a failure if it produced none.
 *
 * `promise.catch(e => expect(...))` cannot do this: when the promise resolves,
 * the callback never runs and the assertions inside it never happen, so the
 * test passes green in exactly the case it exists to catch.
 */
async function rejection(call: () => Promise<unknown>): Promise<Error> {
  let caught: unknown;
  let resolved = false;
  try {
    await call();
    resolved = true;
  } catch (e) {
    caught = e;
  }
  expect(resolved, "expected the call to reject, but it resolved").toBe(false);
  return caught as Error;
}

describe("ConnectorClient", () => {
  it("posts the action to the connector route with a bearer header", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = makeConnectorClient({
      apiBaseUrl: "https://api.example.com",
      credential: () => "cred-123",
      fetchImpl: async (url, init) => {
        seen.push({ url, init: init ?? {} });
        return new Response(JSON.stringify({ channels: [] }), { status: 200 });
      },
    });

    const out = await client.call("channels.list", { account: "T1", limit: 5 });

    expect(seen[0].url).toBe("https://api.example.com/v1/connectors/slack/channels.list");
    expect(seen[0].init.method).toBe("POST");
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe("Bearer cred-123");
    expect(JSON.parse(seen[0].init.body as string)).toEqual({ account: "T1", limit: 5 });
    expect(out).toEqual({ channels: [] });
  });

  it("asks the status route with a GET and no body", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = makeConnectorClient({
      apiBaseUrl: "https://api.example.com",
      credential: () => "cred-123",
      fetchImpl: async (url, init) => {
        seen.push({ url, init: init ?? {} });
        return new Response(JSON.stringify({ connected: true }), { status: 200 });
      },
    });

    expect(await client.call("status", { ignored: true })).toEqual({ connected: true });
    expect(seen[0].url).toBe("https://api.example.com/v1/connectors/slack/status");
    expect(seen[0].init.method).toBe("GET");
    expect(seen[0].init.body).toBeUndefined();
  });

  // The device credential holds `relay:device` and `llm:chat` — agent minting
  // and paid inference — so an action that reaches a DIFFERENT Plow route
  // carries it there. WHATWG URL parsing collapses "../", cuts at "?" and at
  // "#": all three are route selection, and none of them is a Slack call. The
  // assertion that matters is `called`: not "the request was refused" but
  // "there was no request".
  it.each([
    { what: "traversal into another Plow route", action: "../../../v1/relay/agents" },
    { what: "a query that re-points the path", action: "channels.list?x=/../relay/agents" },
    { what: "a fragment that truncates the path", action: "channels.list#/../relay/agents" },
    { what: "an action nobody defined", action: "messages.delete" },
    { what: "no action at all", action: "" },
  ])("refuses $what before any request exists", async ({ action }) => {
    let called = false;
    const client = makeConnectorClient({
      apiBaseUrl: "https://api.example.com",
      credential: () => "cred-123",
      fetchImpl: async () => {
        called = true;
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });

    const error = await rejection(() => client.call(action as SlackAction, {}));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(called).toBe(false);
    // One fixed sentence for all five: the caller's text is not echoed into
    // something the owner reads, so the message cannot vary with it.
    expect(error.message).toBe(ConnectorError.unknownAction().message);
  });

  it("never puts the credential in the error message", async () => {
    const client = makeConnectorClient({
      apiBaseUrl: "https://api.example.com",
      credential: () => "super-secret-cred",
      fetchImpl: async () => new Response("nope", { status: 403 }),
    });

    const error = await rejection(() => client.call("channels.list", {}));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).not.toContain("super-secret-cred");
    expect(error.message).toContain("403");
  });

  it("refuses before any network call when the credential is missing", async () => {
    let called = false;
    const client = makeConnectorClient({
      apiBaseUrl: "https://api.example.com",
      credential: () => "   ",
      fetchImpl: async () => {
        called = true;
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });

    const error = await rejection(() => client.call("channels.list", {}));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(called).toBe(false);
  });

  // A fetch implementation is injectable, so its message is foreign text —
  // the same rule the parse branch below already kept, applied where it was
  // being broken.
  it("classifies a transport failure instead of forwarding its message", async () => {
    const client = makeConnectorClient({
      apiBaseUrl: "https://api.example.com",
      credential: () => "super-secret-cred",
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND api.example.com super-secret-cred");
      },
    });

    const error = await rejection(() => client.call("channels.list", {}));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).not.toContain("super-secret-cred");
    expect(error.message).not.toContain("ENOTFOUND");
    expect(error.message).toContain("could not reach Plow");
  });

  // Told apart because they send someone to fix different things: one is "you
  // are offline", the other is "Plow took it and went quiet".
  it("tells a timeout apart from an unreachable Plow", async () => {
    const client = makeConnectorClient({
      apiBaseUrl: "https://api.example.com",
      credential: () => "cred-123",
      fetchImpl: async () => {
        throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
      },
    });

    const error = await rejection(() => client.call("messages.list", {}));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toContain("did not answer in time");
  });

  it("surfaces an unparsable 200 body as a ConnectorError, not a raw SyntaxError", async () => {
    const client = makeConnectorClient({
      apiBaseUrl: "https://api.example.com",
      credential: () => "super-secret-cred",
      fetchImpl: async () => new Response("not json", { status: 200 }),
    });

    const error = await rejection(() => client.call("channels.list", {}));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).not.toContain("not json");
    expect(error.message).not.toContain("super-secret-cred");
  });
});
