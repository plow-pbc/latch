import { describe, expect, it } from "vitest";
import { buildConnectorClient } from "../src/connectorWiring.js";

describe("connector wiring", () => {
  it("reads the credential lazily, so a re-pair takes effect without a restart", async () => {
    let current = "first";
    const seen: string[] = [];
    const client = buildConnectorClient({
      apiBaseUrl: "https://api.example.com",
      credential: () => current,
      fetchImpl: async (_url, init) => {
        seen.push((init?.headers as Record<string, string>).Authorization);
        return new Response("{}", { status: 200 });
      },
    });

    await client.call("channels.list", {});
    current = "second";
    await client.call("channels.list", {});

    expect(seen).toEqual(["Bearer first", "Bearer second"]);
  });
});
