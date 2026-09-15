/**
 * A plugin through the exec path: the device is the chokepoint (refuse runs
 * before any intent exists), a secret reaches the child's environment and
 * nowhere else, and an `always_allow` rule is keyed on the plugin's allowed
 * read prefix rather than on the caller's literal argv.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSONValue, jv, makeIntent } from "@domo/protocol";

import { DeviceAgent, HeadlessPolicy, impliesNetwork, installPlugin } from "@domo/device-core";

import { fixturePlugin, FIXTURE_ENV, FIXTURE_MINT_ENV } from "./pluginFixtures.js";

const ON_MAC = process.platform === "darwin";
const itSpawns = it.skipIf(!ON_MAC);

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugin-exec-"));
}

function device(intent: "allow_once" | "always_allow" = "allow_once"): DeviceAgent {
  return new DeviceAgent(tmp(), "Test Mac", new HeadlessPolicy({ intent }));
}

function run(d: DeviceAgent, argv: string[], waitMs = 8000): Promise<JSONValue> {
  return d.handleIntent(
    makeIntent({
      agentId: "a1",
      agentDisplay: "Agent",
      deviceId: d.identity.deviceId,
      request: `run: ${argv.join(" ")}`,
      capabilities: [
        { kind: "process.exec", argv },
        { kind: "network", allowed: impliesNetwork(argv) },
      ],
      sessionId: "s1",
    }),
    { wait_ms: waitMs },
  );
}

function expectNeverSpawned(d: DeviceAgent): void {
  const events = d.audit.entries().map((e) => jv(e).get("event").str);
  expect(events).toContain("exec_error");
  expect(events).not.toContain("exec_start");
}

describe("a plugin through the exec path", () => {
  itSpawns("runs the plugin's exec argv with its env, and never puts the secret on argv or in the audit log", async () => {
    const d = device();
    await installPlugin(path.join(d.home, "plugins"), fixturePlugin({ env: FIXTURE_ENV }));
    await d.startPlugins({ plowApiBase: "https://api.example" });
    const secret = fs.readFileSync(path.join(d.home, "plugins/fix/secrets/token"), "utf8");
    const result = await run(d, ["fix", "query", "hello"]);
    const out = jv(result).get("output").str ?? "";
    expect(out).toContain("SECRET_LEN=64");
    expect(out).toContain("ARGV=query hello");
    expect(out).not.toContain(secret);
    const log = d.audit.entries().map((e) => JSON.stringify(e)).join("\n");
    expect(log).not.toContain(secret);
  });

  it("refuses off-allowlist argv at the device, recorded as exec_error, never spawned", async () => {
    const d = device();
    await installPlugin(path.join(d.home, "plugins"), fixturePlugin({ env: FIXTURE_ENV }));
    await d.startPlugins({ plowApiBase: "https://api.example" });
    await run(d, ["fix", "serve"]);
    expectNeverSpawned(d);
  });

  it("a mint env source refuses with a fixed sentence and never spawns", async () => {
    const d = device();
    await installPlugin(path.join(d.home, "plugins"), fixturePlugin({ env: FIXTURE_MINT_ENV }));
    await d.startPlugins({ plowApiBase: "https://api.example" });
    const response = await run(d, ["fix", "query", "hello"]);
    expect(jv(response).get("status").str).toBe("error");
    expect(jv(response).get("error").str).toBe("this Mac is not paired with Plow");
    expectNeverSpawned(d);
  });

  itSpawns("keys an always-allow on the read prefix and on the full argv for a write", async () => {
    const d = device("always_allow");
    await installPlugin(path.join(d.home, "plugins"), fixturePlugin({ env: FIXTURE_ENV }));
    await d.startPlugins({ plowApiBase: "https://api.example" });
    await run(d, ["fix", "query", "one"]);
    const readRule = d.policy.allRules()[0]!;
    const readExec = readRule.capabilities.find((c) => c.kind === "process.exec")!;
    expect(readExec.argv).toEqual(["fix", "query"]);
    await run(d, ["fix", "put", "p"]);
    const writeRule = d.policy.allRules().find((r) => r.ruleKey !== readRule.ruleKey)!;
    const writeExec = writeRule.capabilities.find((c) => c.kind === "process.exec")!;
    expect(writeExec.argv).toEqual(["fix", "put", "p"]);
  });

  it("publishes the plugin's skill once started", async () => {
    const d = device();
    await installPlugin(path.join(d.home, "plugins"), fixturePlugin({ env: FIXTURE_ENV }));
    await d.startPlugins({ plowApiBase: "https://api.example" });
    expect(d.skills.skill("fix")?.description).toBe("the fixture plugin");
  });

  it("reports a broken install as a problem and skips it, without stopping a healthy one", async () => {
    const d = device();
    const pluginsRoot = path.join(d.home, "plugins");
    await installPlugin(pluginsRoot, fixturePlugin({ env: FIXTURE_ENV }));
    const dirs = path.join(pluginsRoot, "bad");
    fs.mkdirSync(path.join(dirs, "repo"), { recursive: true });
    fs.writeFileSync(path.join(dirs, "repo", "latch-plugin.json"), "{not json");
    fs.writeFileSync(
      path.join(dirs, "installed.json"),
      JSON.stringify({ name: "bad", version: "1", command: "bad", commit: "a".repeat(40), installedAt: new Date().toISOString() }),
    );
    const problems = await d.startPlugins({ plowApiBase: "https://api.example" });
    expect(problems).toEqual([{ name: "bad", problem: "manifest is not valid JSON" }]);
    expect(d.plugins.all().map((p) => p.manifest.name)).toEqual(["fix"]);
  });
});
