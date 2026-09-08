import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
// @ts-expect-error — renderer modules ship as JavaScript.
import { agentSettingsForm } from "../src/renderer/agentSettings.js";
import { CloudAgentsClient, type AgentSettingsValues } from "../src/cloudAgents.js";
import { PlowApi } from "../src/plowApi.js";

const settings = {
  daily_payment_cap_usd: { type: ["number", "null"], value: 200 },
  verbose_output: { type: "boolean", value: false },
};
const resource = { uid: "a", name: "Willow", provider: "exe:life", status: "running", settings,
  line: null, credential: null, image: null, url: null, created_at: "2026-09-08T00:00:00Z" };

describe("the two platform settings controls against a stubbed agents API", () => {
  it.each([25.5, null])("saves cap %s and verbose as typed values", async (value) => {
    const dom = new JSDOM("<body></body>");
    const calls: { path: string; body: unknown }[] = [];
    const client = new CloudAgentsClient(new PlowApi("https://stub.invalid", async (url, init) => {
      calls.push({ path: new URL(url).pathname, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(resource));
    }));
    const form = agentSettingsForm(dom.window.document, settings, (values: AgentSettingsValues) => client.settings("owner", "a", values));
    dom.window.document.body.append(form);
    expect(form.querySelectorAll("input")).toHaveLength(2);
    const cap = form.querySelector('input[type="number"]');
    const verbose = form.querySelector('input[type="checkbox"]');
    expect(cap.value).toBe("200");
    expect(verbose.checked).toBe(false);
    cap.value = value ?? "";
    verbose.checked = true;
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual([{ path: "/v1/agents/a/settings", body: { daily_payment_cap_usd: value, verbose_output: true } }]);
    expect(form.textContent).toContain("Settings saved.");
  });
  it("shows a failed PATCH and preserves the entered values", async () => {
    const dom = new JSDOM("<body></body>");
    const api = new PlowApi("https://stub.invalid", async () => new Response("{}", { status: 502 }));
    const form = agentSettingsForm(dom.window.document, settings, (values: AgentSettingsValues) => new CloudAgentsClient(api).settings("owner", "a", values));
    dom.window.document.body.append(form);
    form.querySelector('input[type="number"]').value = "18";
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(form.textContent).toContain("Plow returned 502.");
    expect(form.querySelector('input[type="number"]').value).toBe("18");
  });
});
