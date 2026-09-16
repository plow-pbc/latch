import { describe, expect, it } from "vitest";
import { resolveEnv, substitute } from "../src/plugins/env.js";
import { parseManifest, PluginError } from "../src/plugins/manifest.js";
import { MINIMAL } from "./pluginFixtures.js";

const m = parseManifest(JSON.stringify({ ...MINIMAL, env: {
  A_HOME: { fixed: "${plugin_home}" }, A_URL: { fixed: "http://127.0.0.1:${port}" },
  A_BASE: { fixed: "${plow_api_base}/v1" }, A_OWNER: { fixed: "${owner_home}/Plow/wiki" },
  A_TOKEN: { secret: "daemon-token" }, A_KEY: { mint: "llm:chat" },
}}));
const ctx = {
  pluginHome: "/p/home", ownerHome: "/Users/owner", port: 4242, plowApiBase: "https://api.example",
  secret: (n: string) => `S:${n}`, mint: async (s: string) => `M:${s}`,
};

describe("resolveEnv", () => {
  it("substitutes every placeholder and reads each source", async () => {
    await expect(resolveEnv(m, ctx)).resolves.toEqual({
      A_HOME: "/p/home", A_URL: "http://127.0.0.1:4242", A_BASE: "https://api.example/v1",
      A_OWNER: "/Users/owner/Plow/wiki", A_TOKEN: "S:daemon-token", A_KEY: "M:llm:chat",
    });
  });
  it("refuses ${port} for a plugin with no daemon", () => {
    expect(() => substitute("x${port}", { ...ctx, port: null })).toThrow(new PluginError("${port} needs a daemon"));
  });
  it("refuses a mint when this Mac cannot mint", async () => {
    await expect(resolveEnv(m, { ...ctx, mint: null })).rejects.toThrow(new PluginError("this Mac is not paired with Plow"));
  });
});
