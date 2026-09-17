import { describe, expect, it } from "vitest";
import { resolveEnv } from "../src/plugins/env.js";
import { parseManifest } from "../src/plugins/manifest.js";
import { MINIMAL } from "./pluginFixtures.js";

describe("resolveEnv", () => {
  it("substitutes ${plugin_home} and ${owner_home} into every fixed value", () => {
    const m = parseManifest(JSON.stringify({ ...MINIMAL, env: {
      A_HOME: { fixed: "${plugin_home}/data" }, A_WIKI: { fixed: "${owner_home}/Plow/wiki" }, A_PLAIN: { fixed: "x" },
    }}));
    expect(resolveEnv(m, { pluginHome: "/p/home", ownerHome: "/Users/owner" })).toEqual({
      A_HOME: "/p/home/data", A_WIKI: "/Users/owner/Plow/wiki", A_PLAIN: "x",
    });
  });
});
