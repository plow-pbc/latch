/**
 * `blocked` on the wire: the third answer beside `denied` and `failed`
 * (§4.3), for an operation the owner approved and this Mac itself then
 * refused. These pin the shape an agent sees — direct, through a job
 * handle, and through a deferred handle — and that a diagnosed `failed`
 * keeps its facts. The refusals are real (a chmod 000 file, a sandboxed
 * write outside its profile) or scripted at the probe seam; the audit log
 * is the oracle for what the device recorded.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize, JSONValue, jv } from "@domo/protocol";
import {
  DeviceAgent,
  HeadlessPolicy,
  HostProbes,
  PolicyDelegate,
  scriptedProbes,
} from "@domo/device-core";
import { createDomoMcpServer, DomoMcpServer, RelayAuth } from "@domo/mcp-server";
import { callTool, pollUntil } from "./client.js";

const ON_MAC = process.platform === "darwin";
const AS_ROOT = process.getuid?.() === 0;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-mcpgate-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return canonicalize(dir);
}

const AGENT: RelayAuth = { agent_id: "agent-1", agent_name: "Agent One" };
const OTHER: RelayAuth = { agent_id: "agent-2", agent_name: "Agent Two" };

/** A device whose owner's home is a fixture and whose probes a test scripts. */
function makeServer(
  probes: HostProbes | null = null,
  delegate: PolicyDelegate = new HeadlessPolicy({ intent: "allow_once" }),
  budgetMs?: number,
): { server: DomoMcpServer; device: DeviceAgent; home: string } {
  const home = tempDir();
  const device = new DeviceAgent(home, "Test Mac", delegate, null, home, null, [], null, probes);
  const server = createDomoMcpServer(device, budgetMs === undefined ? {} : { budgetMs });
  cleanups.push(() => server.close());
  return { server, device, home };
}

const events = (device: DeviceAgent): string[] =>
  device.audit.entries().map((e) => jv(e as JSONValue).get("event").str ?? "");

function unreadable(dir: string): string {
  const file = path.join(dir, "secret.txt");
  fs.writeFileSync(file, "x");
  fs.chmodSync(file, 0o000);
  cleanups.push(() => fs.chmodSync(file, 0o600));
  return file;
}

describe.skipIf(AS_ROOT)("a file this Mac refused", () => {
  it("plow_read_file answers blocked, as an error, with the whole diagnosis", async () => {
    const { server, device, home } = makeServer();
    const file = unreadable(path.join(home, "Plow"));
    const { payload, isError, status } = await callTool(server, "plow_read_file", { path: file }, AGENT);
    expect(status).toBe(200);
    expect(isError).toBe(true);
    expect(payload.status).toBe("blocked");
    expect(payload.error).toMatch(/EACCES/);
    expect(payload.diagnosis.cause).toBe("posix_permissions");
    expect(payload.diagnosis.confidence).toBe("confirmed");
    expect(payload.diagnosis.owner_action).toMatch(/chown\/chmod/);
    expect(payload.diagnosis.retry).toBe("with_different_path");
    expect(payload.probes.posix_readable).toBe(false);
    expect(payload.probes.path).toBe("~/Plow/secret.txt");
    expect(events(device)).toEqual(["intent_received", "intent_decision", "host_permission_blocked"]);
  });

  it.skipIf(!ON_MAC)("a TCC refusal is told in the owner's terms, with the switch named", async () => {
    // A real EPERM underneath — TCC's errno, produced here by a locked file —
    // and probes that answer as a Mac whose owner has not granted the
    // Documents folder would. (A chmod 000 file would not do: its EACCES is
    // ordinary permissions, and the tree rightly says so.)
    const home = tempDir();
    fs.mkdirSync(path.join(home, "Documents"));
    const file = path.join(home, "Documents", "notes.txt");
    fs.writeFileSync(file, "old");
    execFileSync("/usr/bin/chflags", ["uchg", file]);
    cleanups.push(() => execFileSync("/usr/bin/chflags", ["nouchg", file]));
    const probes = scriptedProbes({
      inspect: { [file]: { isDirectory: false, readable: true, writable: true, flags: [] } },
      openAsApp: { [file]: "EPERM" },
      fullDiskAccess: false,
    });
    const device = new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "allow_once" }), null, home, null, [], null, probes);
    const server = createDomoMcpServer(device);
    cleanups.push(() => server.close());

    const { payload, isError } = await callTool(server, "plow_write_file", { path: file, content: "new" }, AGENT);
    expect(isError).toBe(true);
    expect(payload.status).toBe("blocked");
    expect(payload.diagnosis.cause).toBe("macos_permission");
    expect(payload.diagnosis.permission).toBe("files_documents");
    expect(payload.diagnosis.owner_action).toMatch(/System Settings > Privacy & Security > Files and Folders > Documents Folder, allow Plow Latch/);
    expect(payload.diagnosis.ruled_out).toContain("sandbox bound");
    expect(payload.probes.full_disk_access_granted).toBe(false);
    // Nothing owner-identifying in what this Mac ADDED: the diagnosis and
    // the probes fold the home to `~`. (`error` is the kernel's own sentence
    // and names the path the agent itself supplied.)
    expect(JSON.stringify(payload.diagnosis)).not.toContain(home);
    expect(JSON.stringify(payload.probes)).not.toContain(home);
    expect(payload.probes.path).toBe("~/Documents/notes.txt");
  });

  it("a missing file stays failed, and keeps the facts this Mac gathered", async () => {
    const { server, home } = makeServer();
    const { payload, isError } = await callTool(
      server,
      "plow_read_file",
      { path: path.join(home, "Plow", "absent.txt") },
      AGENT,
    );
    expect(isError).toBe(true);
    expect(payload.status).toBeUndefined();
    expect(payload.error).toMatch(/ENOENT/);
    expect(payload.diagnosis.cause).toBe("not_found");
    expect(payload.diagnosis.owner_action).toBeNull();
    expect(payload.probes.path_exists).toBe(false);
  });

  it("a blocked deferred call lands as blocked on its handle", async () => {
    // A human who takes longer than the budget, then approves: the call
    // defers, the read then runs and is refused, and the handle carries it.
    const slow: PolicyDelegate = {
      decideIntent: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return "allow_once";
      },
    };
    const { server, home } = makeServer(null, slow, 40);
    const file = unreadable(path.join(home, "Plow"));
    const first = await callTool(server, "plow_read_file", { path: file }, AGENT);
    expect(first.payload.status).toBe("pending");
    const handle = first.payload.handle as string;

    const settled = await pollUntil(
      () => callTool(server, "plow_get_result", { handle }, AGENT),
      (r) => r.payload.status !== "pending",
    );
    expect(settled.payload.status).toBe("blocked");
    expect(settled.payload.handle).toBe(handle);
    expect(settled.payload.diagnosis.cause).toBe("posix_permissions");
    expect(settled.payload.probes.errno).toBe("EACCES");
    // Ownership holds for blocked results like every other terminal state.
    const theirs = await callTool(server, "plow_get_result", { handle }, OTHER);
    expect(theirs.payload.status).toBe("unknown");
  });
});

describe.skipIf(!ON_MAC)("a command this Mac refused", () => {
  it("plow_run_command answers blocked with the run's output and handle, and the handle still polls", async () => {
    const { server, device, home } = makeServer();
    const elsewhere = tempDir();
    const target = path.join(elsewhere, "out.txt");
    const { payload, isError } = await callTool(
      server,
      "plow_run_command",
      { argv: ["/bin/sh", "-c", `echo hi > ${JSON.stringify(target)}`], cwd: home, wait_ms: 5_000 },
      AGENT,
    );
    expect(isError).toBe(true);
    expect(payload.status).toBe("blocked");
    expect(payload.exit_code).not.toBe(0);
    expect(payload.output).toMatch(/Operation not permitted/);
    expect(payload.diagnosis.cause).toBe("outside_approved_bound");
    expect(payload.diagnosis.owner_action).toMatch(/write_paths/);
    expect(typeof payload.handle).toBe("string");

    // The job was claimed for this agent even though the call was an error…
    const polled = await callTool(server, "plow_get_output", { handle: payload.handle }, AGENT);
    expect(polled.isError).toBe(false);
    expect(polled.payload.status).toBe("blocked");
    expect(polled.payload.diagnosis.cause).toBe("outside_approved_bound");
    // …and for nobody else.
    const theirs = await callTool(server, "plow_get_output", { handle: payload.handle }, OTHER);
    expect(theirs.isError).toBe(true);
    expect(theirs.payload.error).toMatch(/unknown output handle/);

    expect(events(device)).toEqual([
      "intent_received",
      "intent_decision",
      "exec_start",
      "exec_end",
      "host_permission_blocked",
    ]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("an ordinary failing command is still completed with its exit code", async () => {
    const { server, home } = makeServer(scriptedProbes());
    const { payload, isError } = await callTool(
      server,
      "plow_run_command",
      { argv: ["/bin/sh", "-c", "echo nope >&2; exit 2"], cwd: home, wait_ms: 5_000 },
      AGENT,
    );
    expect(isError).toBe(false);
    expect(payload.status).toBe("completed");
    expect(payload.exit_code).toBe(2);
    expect(payload.diagnosis).toBeUndefined();
  });
});
