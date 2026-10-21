import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize, type Intent, jv } from "@domo/protocol";
import { DeviceAgent, HeadlessPolicy, loadPlugins, type PolicyDelegate } from "@domo/device-core";
import { createDomoMcpServer, type RelayAuth } from "@domo/mcp-server";
import { tempDirs } from "../../device-core/test/pluginFixtures.js";
import { callTool } from "./client.js";

const shipped = fileURLToPath(new URL("../../../apps/desktop/plugins/screenpipe", import.meta.url));
const agent: RelayAuth = { agent_id: "screenpipe-test", agent_name: "History assistant", scopes: ["relay:call"] };
const { tmp, cleanup } = tempDirs("latch-screenpipe-mcp-");
const servers: ReturnType<typeof createDomoMcpServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  cleanup();
});

function fixture(delegate: PolicyDelegate = new HeadlessPolicy({ intent: "allow_once" })) {
  const root = tmp();
  fs.cpSync(shipped, path.join(root, "screenpipe"), { recursive: true });
  const home = tmp();
  const device = new DeviceAgent(home, "Test Mac", delegate, null, undefined, null, loadPlugins([root]));
  const server = createDomoMcpServer(device);
  servers.push(server);
  return { server, device, dir: canonicalize(path.join(root, "screenpipe")) };
}

const events = (device: DeviceAgent) => device.audit.entries().map((entry) => jv(entry).get("event").str);

describe("Screenpipe through Latch MCP", () => {
  it("publishes the shipped skill and withdraws it when the owner switches the plugin off", async () => {
    const { server, device } = fixture();
    const listed = await callTool(server, "plow_list_skills", {}, agent);
    expect(JSON.stringify(listed.payload)).toContain("plow-screenpipe");
    const skill = await callTool(server, "plow_read_skill", { name: "plow-screenpipe" }, agent);
    expect(JSON.stringify(skill.payload)).toContain("network=true");
    expect(jv(skill.payload).get("body").str).toContain(
      'plow_run_command(argv=["plow-screenpipe", "install"], network=true, write_paths=["~/.screenpipe"])',
    );

    await device.setDisabledPlugins(["screenpipe"]);
    const off = await callTool(server, "plow_list_skills", {}, agent);
    expect(JSON.stringify(off.payload)).not.toContain("plow-screenpipe");
    const refused = await callTool(server, "plow_run_command", { argv: ["plow-screenpipe", "search"], network: true }, agent);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.payload)).toContain("turned off");
    expect(events(device)).not.toContain("intent_received");

    await device.setDisabledPlugins([]);
    const restored = await callTool(server, "plow_list_skills", {}, agent);
    expect(JSON.stringify(restored.payload)).toContain("plow-screenpipe");
  });

  it.each(["record", "stop", "sql", "export-video", "notify", "pipe", "control"])("refuses %s before approval or execution", async (command) => {
    const { server, device } = fixture();
    const result = await callTool(server, "plow_run_command", { argv: ["plow-screenpipe", command], network: true }, agent);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.payload)).toContain("allows: health, search, --help");
    expect(events(device)).not.toContain("intent_received");
    expect(events(device)).not.toContain("exec_start");
  });

  it("offers the actual query, plugin directory and network permission for approval; denial prevents execution", async () => {
    let offered: Intent | null = null;
    const { server, device, dir } = fixture({
      async decideIntent(intent) { offered = intent; return "deny"; },
    });
    const argv = ["plow-screenpipe", "search", "--query", "synthetic design review", "--content-type", "accessibility"];
    const result = await callTool(server, "plow_run_command", { argv, network: true }, agent);
    expect(result.payload).toMatchObject({ status: "denied" });
    expect(offered).toMatchObject({ capabilities: expect.arrayContaining([
      { kind: "process.exec", argv, cwd: dir }, { kind: "network", allowed: true },
    ]) });
    expect(events(device)).toContain("intent_received");
    expect(events(device)).toContain("intent_decision");
    expect(events(device)).not.toContain("exec_start");
  });

  it("keeps network denied when the caller omits it", async () => {
    let offered: Intent | null = null;
    const { server } = fixture({ async decideIntent(intent) { offered = intent; return "deny"; } });
    await callTool(server, "plow_run_command", { argv: ["plow-screenpipe", "health"] }, agent);
    expect(offered).toMatchObject({ capabilities: expect.arrayContaining([{ kind: "network", allowed: false }]) });
  });

  it("requires approval for installation with its network and owner directory write; denial prevents execution", async () => {
    let offered: Intent | null = null;
    const { server, device, dir } = fixture({ async decideIntent(intent) { offered = intent; return "deny"; } });
    const argv = ["plow-screenpipe", "install"];
    const result = await callTool(server, "plow_run_command", {
      argv, network: true, write_paths: ["~/.screenpipe"],
    }, agent);
    expect(result.payload).toMatchObject({ status: "denied" });
    expect(offered).toMatchObject({ capabilities: expect.arrayContaining([
      { kind: "process.exec", argv, cwd: dir }, { kind: "network", allowed: true },
      { kind: "fs.write", paths: [expect.stringMatching(/\/\.screenpipe$/)] },
    ]) });
    expect(events(device)).toContain("intent_decision");
    expect(events(device)).not.toContain("exec_start");
  });

  it("refuses a caller-supplied working directory before an intent exists", async () => {
    const { server, device, dir } = fixture();
    const result = await callTool(server, "plow_run_command", { argv: ["plow-screenpipe", "health"], cwd: dir, network: true }, agent);
    expect(result.isError).toBe(true);
    expect(events(device)).not.toContain("intent_received");
  });

  it.skipIf(process.platform !== "darwin")("runs the shipping help entrypoint through seatbelt and audits the agent's command", async () => {
    const { server, device } = fixture();
    const result = await callTool(server, "plow_run_command", { argv: ["plow-screenpipe", "--help"], wait_ms: 5000 }, agent);
    expect(result.isError, JSON.stringify(result.payload)).toBe(false);
    expect(JSON.stringify(result.payload)).toContain("plow-screenpipe search");
    expect(device.audit.entries().some((entry) => jv(entry).get("event").str === "exec_start"
      && JSON.stringify(jv(entry).get("argv").value) === JSON.stringify(["plow-screenpipe", "--help"]))).toBe(true);
    expect(events(device)).toContain("exec_end");
  });
});
