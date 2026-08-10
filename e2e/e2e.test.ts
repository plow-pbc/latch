/**
 * Full-stack scenarios: real broker process, real headless device process, real
 * MCP traffic. Each test boots a fresh stack in a throwaway DOMO_HOME and
 * asserts on the audit log.
 *
 * (During the Swift→TS migration this ran as a cross-implementation matrix;
 * with Swift removed it's TS broker + TS device. The `matrix`/`config` shape is
 * kept so alternate binary configurations can be re-added trivially.)
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { JSONValue, jv } from "@domo/protocol";
import { BinaryConfig, MCPTestClient, TestStack, TS_BROKER, TS_DEVICE } from "./stack.js";

interface Matrix {
  name: string;
  bin: BinaryConfig;
}

const matrix: Matrix[] = [{ name: "TS broker + TS device", bin: { broker: TS_BROKER, device: TS_DEVICE } }];

for (const config of matrix) {
  describe(`E2E — ${config.name}`, () => {
    let stack: TestStack | null = null;

    afterEach(async () => {
      await stack?.shutdown();
      stack = null;
    });

    async function makeStack(policy?: JSONValue): Promise<{ stack: TestStack; client: MCPTestClient }> {
      const s = new TestStack(config.bin);
      stack = s;
      const agent = await s.createAgent("E2E Agent");
      await s.startBroker();
      await s.startDevice({ policy });
      const client = await MCPTestClient.connect(s.agentSocket, agent.token);
      expect(client.authOk).toBe(true);
      await client.initializeSession();
      return { stack: s, client };
    }

    async function requestAccess(client: MCPTestClient, s: TestStack, goals = "run E2E test scenarios") {
      const [result, isError] = await client.callTool("request_device_access", {
        device: s.deviceId,
        goals,
      });
      expect(isError).toBe(false);
      expect(jv(result).get("status").str).toBe("granted");
    }

    function eventNames(s: TestStack): string[] {
      return s.auditEvents().map((e) => jv(e).get("event").str ?? "");
    }

    it("discovery and access grant", async () => {
      const { stack: s, client } = await makeStack();

      const tools = jv(await client.request("tools/list"));
      const names = (tools.get("result").get("tools").arr ?? []).map((t) => jv(t).get("name").str);
      expect(names).toContain("run_command");
      expect(names).toContain("request_device_access");

      const [devices] = await client.callTool("list_devices");
      const entry = (jv(devices).get("devices").arr ?? []).find(
        (d) => jv(d).get("id").str === s.deviceId,
      );
      expect(entry).toBeTruthy();
      expect(jv(entry!).get("online").bool).toBe(true);
      expect(jv(entry!).get("granted").bool).toBe(false);

      // Operations before a grant are refused at the broker.
      const [, deniedEarly] = await client.callTool("read_file", {
        device: s.deviceId,
        path: "/tmp/x",
      });
      expect(deniedEarly).toBe(true);

      await requestAccess(client, s);
      const [after] = await client.callTool("list_devices");
      const grantedEntry = (jv(after).get("devices").arr ?? []).find(
        (d) => jv(d).get("id").str === s.deviceId,
      );
      expect(jv(grantedEntry!).get("granted").bool).toBe(true);

      const events = eventNames(s);
      expect(events).toContain("access_request");
      expect(events).toContain("access_decision");
      client.close();
    });

    it("file round-trip and scope enforcement", async () => {
      const { stack: s, client } = await makeStack();
      await requestAccess(client, s);
      const file = path.join(s.home, "work/note.txt");

      const [written, writeError] = await client.callTool("write_file", {
        device: s.deviceId,
        path: file,
        content: "hello from the agent",
        goal: "test write",
      });
      expect(writeError).toBe(false);
      expect(jv(written).get("bytes").int).toBe(20);

      const [read, readError] = await client.callTool("read_file", {
        device: s.deviceId,
        path: file,
      });
      expect(readError).toBe(false);
      expect(jv(read).get("content").str).toBe("hello from the agent");

      const events = eventNames(s);
      expect(events).toContain("file_write");
      expect(events).toContain("file_read");
      client.close();
    });

    it("run_command sandboxed", async () => {
      const { stack: s, client } = await makeStack();
      await requestAccess(client, s);
      const workdir = path.join(s.home, "work");
      fs.mkdirSync(workdir, { recursive: true });
      const target = path.join(workdir, "made-by-agent.txt");

      const [result, isError] = await client.callTool("run_command", {
        device: s.deviceId,
        argv: ["/bin/sh", "-c", `echo sandboxed > ${target} && cat ${target}`],
        write_paths: [workdir],
        goal: "prove exec works",
      });
      expect(isError, JSON.stringify(result)).toBe(false);
      expect(jv(result).get("status").str).toBe("completed");
      expect(jv(result).get("exit_code").int).toBe(0);
      expect(jv(result).get("output").str).toBe("sandboxed\n");
      expect(fs.readFileSync(target, "utf8")).toBe("sandboxed\n");
      client.close();
    });

    it("sandbox blocks an undeclared write", async () => {
      const { stack: s, client } = await makeStack();
      await requestAccess(client, s);
      const declared = path.join(s.home, "declared");
      const undeclared = path.join(s.home, "undeclared");
      fs.mkdirSync(declared, { recursive: true });
      fs.mkdirSync(undeclared, { recursive: true });
      const escape = path.join(undeclared, "escape.txt");

      const [result] = await client.callTool("run_command", {
        device: s.deviceId,
        argv: ["/bin/sh", "-c", `echo gotcha > ${escape}`],
        write_paths: [declared],
      });
      expect(jv(result).get("status").str).toBe("completed");
      expect(jv(result).get("exit_code").int).not.toBe(0);
      expect(fs.existsSync(escape)).toBe(false);
      client.close();
    });

    it("streaming output via get_output", async () => {
      const { stack: s, client } = await makeStack();
      await requestAccess(client, s);

      const [started, isError] = await client.callTool("run_command", {
        device: s.deviceId,
        argv: ["/bin/sh", "-c", "echo begin; sleep 1; echo end"],
        wait_ms: 300,
      });
      expect(isError).toBe(false);
      expect(jv(started).get("status").str).toBe("running");
      const handle = jv(started).get("handle").str!;
      expect(handle).toBeTruthy();
      expect(jv(started).get("output").str ?? "").toContain("begin");

      let seen = jv(started).get("output_length").int ?? 0;
      let tail = "";
      let finished = false;
      for (let i = 0; i < 50; i++) {
        const [chunk, chunkError] = await client.callTool("get_output", {
          device: s.deviceId,
          handle,
          since: seen,
        });
        expect(chunkError).toBe(false);
        tail += jv(chunk).get("output").str ?? "";
        seen = jv(chunk).get("output_length").int ?? seen;
        if (jv(chunk).get("status").str === "completed") {
          expect(jv(chunk).get("exit_code").int).toBe(0);
          finished = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(finished).toBe(true);
      expect(tail).toContain("end");
      expect(tail).not.toContain("begin"); // since-offset should not resend
      client.close();
    });

    it("always-allow rule reuse", async () => {
      const { stack: s, client } = await makeStack({ access: "allow", intent: "always_allow" });
      await requestAccess(client, s);

      for (let i = 0; i < 2; i++) {
        const [result, isError] = await client.callTool("run_command", {
          device: s.deviceId,
          argv: ["/bin/echo", "repeat"],
        });
        expect(isError).toBe(false);
        expect(jv(result).get("exit_code").int).toBe(0);
      }

      const sources = s
        .auditEvents()
        .filter((e) => jv(e).get("event").str === "intent_decision")
        .map((e) => jv(e).get("source").str);
      expect(sources).toEqual(["prompt", "rule"]);

      // A different argv is a different rule key → prompt again.
      await client.callTool("run_command", {
        device: s.deviceId,
        argv: ["/bin/echo", "different"],
      });
      const sourcesAfter = s
        .auditEvents()
        .filter((e) => jv(e).get("event").str === "intent_decision")
        .map((e) => jv(e).get("source").str);
      expect(sourcesAfter).toEqual(["prompt", "rule", "prompt"]);
      client.close();
    });

    it("denial flow is capability-specific", async () => {
      const { stack: s, client } = await makeStack({
        access: "allow",
        intent: "allow_once",
        denyKinds: ["process.exec"],
      });
      await requestAccess(client, s);

      const target = path.join(s.home, "never.txt");
      const [result, isError] = await client.callTool("run_command", {
        device: s.deviceId,
        argv: ["/bin/sh", "-c", `echo no > ${target}`],
        write_paths: [s.home],
      });
      expect(isError).toBe(true);
      expect(jv(result).str ?? "").toContain("denied");
      expect(fs.existsSync(target)).toBe(false);

      // fs.write is not in denyKinds, so file ops still work.
      const [, writeError] = await client.callTool("write_file", {
        device: s.deviceId,
        path: target,
        content: "ok",
      });
      expect(writeError).toBe(false);
      client.close();
    });

    it("access denied by owner blocks operations", async () => {
      const { stack: s, client } = await makeStack({ access: "deny", intent: "deny" });
      const [result, isError] = await client.callTool("request_device_access", {
        device: s.deviceId,
        goals: "up to no good",
      });
      expect(isError).toBe(false);
      expect(jv(result).get("status").str).toBe("denied");

      const [, opError] = await client.callTool("read_file", {
        device: s.deviceId,
        path: "/tmp/x",
      });
      expect(opError).toBe(true);
      client.close();
    });

    it("blessed tools", async () => {
      const { stack: s, client } = await makeStack();
      await requestAccess(client, s);

      const [tools, listError] = await client.callTool("list_device_tools", {
        device: s.deviceId,
      });
      expect(listError).toBe(false);
      const names = (jv(tools).get("tools").arr ?? []).map((t) => jv(t).get("name").str);
      expect(names).toContain("mac_info");

      const [result, useError] = await client.callTool("use_tool", {
        device: s.deviceId,
        tool: "mac_info",
      });
      expect(useError).toBe(false);
      expect(jv(result).get("result").get("hostname").str).toBeTruthy();
      expect(jv(result).get("result").get("os_version").str).toBeTruthy();
      client.close();
    });

    it("agent created after broker start authenticates (reload-on-miss)", async () => {
      const s = new TestStack(config.bin);
      stack = s;
      await s.startBroker();
      await s.startDevice();
      const late = await s.createAgent("Late Agent"); // after startBroker

      const client = await MCPTestClient.connect(s.agentSocket, late.token);
      expect(client.authOk).toBe(true);
      await client.initializeSession();
      const [result, isError] = await client.callTool("request_device_access", {
        device: s.deviceId,
        goals: "late arrival",
      });
      expect(isError).toBe(false);
      expect(jv(result).get("status").str).toBe("granted");
      client.close();
    });

    it("bad token is rejected", async () => {
      const s = new TestStack(config.bin);
      stack = s;
      await s.createAgent("Real Agent");
      await s.startBroker();
      const impostor = await MCPTestClient.connect(s.agentSocket, "stolen-token");
      expect(impostor.authOk).toBe(false);
      expect(impostor.authRejected).toBe(true);
      impostor.close();
    });

    it("spawn-agent flow pre-approves the device", async () => {
      const s = new TestStack(config.bin);
      stack = s;
      await s.startBroker();
      const tokenOut = path.join(s.home, "spawn-token.json");
      await s.startDevice({ spawnGoal: "organize my Downloads folder", spawnTokenOut: tokenOut });

      const spawned = jv(JSON.parse(fs.readFileSync(tokenOut, "utf8")));
      const token = spawned.get("token").str!;
      expect(token).toBeTruthy();

      const client = await MCPTestClient.connect(s.agentSocket, token);
      expect(client.authOk).toBe(true);
      await client.initializeSession();

      const [devices] = await client.callTool("list_devices");
      const entry = (jv(devices).get("devices").arr ?? []).find(
        (d) => jv(d).get("id").str === s.deviceId,
      );
      expect(jv(entry!).get("granted").bool).toBe(true);

      const [result, isError] = await client.callTool("run_command", {
        device: s.deviceId,
        argv: ["/bin/echo", "spawned"],
      });
      expect(isError, JSON.stringify(result)).toBe(false);
      expect(jv(result).get("output").str).toBe("spawned\n");
      client.close();
    });
  });
}
