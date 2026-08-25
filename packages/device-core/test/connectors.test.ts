import { describe, expect, it } from "vitest";
import { makeConnectorClient, ConnectorError } from "../src/connectors.js";

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
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe("Bearer cred-123");
    expect(JSON.parse(seen[0].init.body as string)).toEqual({ account: "T1", limit: 5 });
    expect(out).toEqual({ channels: [] });
  });

  it("never puts the credential in the error message", async () => {
    const client = makeConnectorClient({
      apiBaseUrl: "https://api.example.com",
      credential: () => "super-secret-cred",
      fetchImpl: async () => new Response("nope", { status: 403 }),
    });

    await expect(client.call("channels.list", {})).rejects.toThrow(ConnectorError);
    await client.call("channels.list", {}).catch((e: Error) => {
      expect(e.message).not.toContain("super-secret-cred");
      expect(e.message).toContain("403");
    });
  });
});
