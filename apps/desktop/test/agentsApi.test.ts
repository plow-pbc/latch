import { describe, expect, it } from "vitest";
import { CloudAgentsClient } from "../src/cloudAgents.js";
import { PlowApi } from "../src/plowApi.js";
import { CloudLinesClient } from "../src/cloudAgentState.js";

const settings = {
  daily_payment_cap_usd: { type: ["number", "null"], value: 200 },
  verbose_output: { type: "boolean", value: false },
};
const agent = {
  uid: "local-1", name: "Kitchen", provider: "local", status: null,
  failure_code: null, url: null, image: null,
  line: { uid: "line-1", display_name: "Willow", provider_key: "+14155550100" },
  credential: { id: 12, name: "Kitchen", scopes: ["relay:call"], connected: true,
    created_at: "2026-09-08T00:00:00Z", last_used_at: null, last_seen_at: null },
  settings, created_at: "2026-09-08T00:00:00Z",
};
function stub(bodies: unknown[]) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const api = new PlowApi("https://stub.invalid", async (url, init) => {
    calls.push({ path: new URL(url).pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(bodies.shift()), { status: 200 });
  });
  return { api, calls };
}
describe("agents API cutover", () => {
  it("lists local and failed cloud agents without a credential join or chat grant", async () => {
    const { api, calls } = stub([[agent, { ...agent, uid: "failed", provider: "exe:life", status: "failed", credential: null }]]);
    const rows = await new CloudAgentsClient(api).list("owner");
    expect(rows).toMatchObject([{ agentId: "local-1", status: null, settings, line: agent.line }, { agentId: "failed", credential: null }]);
    expect(calls[0].path).toBe("/v1/agents");
  });
  it("reads free-line ownership from lines", async () => {
    const { api } = stub([{ data: [{ ...agent.line, agent_uid: "local-1" }, { ...agent.line, uid: "free", agent_uid: null }] }]);
    expect(await new CloudLinesClient(api).list("owner")).toMatchObject([{ agentUid: "local-1" }, { uid: "free", agentUid: null }]);
  });
  it("includes local in the new provider picker", async () => {
    const { api, calls } = stub([[{ id: "local", name: "Self-hosted", image: null, settings }]]);
    expect(await api.listCloudAgentProviders("owner")).toEqual([{ id: "local", name: "Self-hosted" }]);
    expect(calls[0].path).toBe("/v1/agents/providers");
  });
  it("creates a local agent, delivers its token once, patches platform settings and deletes by agent uid", async () => {
    const { api, calls } = stub([{ agent, token: "new-agent-token" }, agent, { uid: agent.uid }]);
    const tokens: string[] = [];
    const client = new CloudAgentsClient(api, undefined, (token) => tokens.push(token));
    const created = await client.create("owner", { name: "Kitchen", provider: "local", lineUid: "line-1" });
    expect(created).not.toHaveProperty("token");
    await client.settings("owner", "local/1", { daily_payment_cap_usd: 15, verbose_output: true });
    await client.delete("owner", "local/1");
    expect(calls).toEqual([
      { method: "POST", path: "/v1/agents", body: { name: "Kitchen", provider: "local", line_uid: "line-1" } },
      { method: "PATCH", path: "/v1/agents/local%2F1/settings", body: { daily_payment_cap_usd: 15, verbose_output: true } },
      { method: "DELETE", path: "/v1/agents/local%2F1", body: null },
    ]);
    expect(tokens).toEqual(["new-agent-token"]);
  });
  it("reports a failed restart returned by a successful settings PATCH", async () => {
    const { api } = stub([{ ...agent, provider: "exe:life", status: "failed", failure_code: "setup_failed" }]);
    await expect(new CloudAgentsClient(api).settings("owner", "cloud", { daily_payment_cap_usd: null, verbose_output: true })).rejects.toThrow("restart failed");
  });
});
