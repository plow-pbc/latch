/**
 * What the agent is TOLD, as opposed to what the tools do.
 *
 * These strings are the whole reason an agent reaches for this Mac or reaches
 * for its own workspace instead, so they are behaviour, not decoration: users
 * were having to say "with Plow, do X" because nothing in the manifest said
 * whose computer these tools touch. The assertions below are deliberately
 * about MEANING (does the surface name the user's machine, does it say what to
 * do with a pending handle) rather than exact sentences, so the copy can be
 * reworded without a test rewrite — but it cannot silently lose its point.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeviceAgent, HeadlessPolicy } from "@domo/device-core";
import { createDomoMcpServer, DomoMcpServer, SERVER_INSTRUCTIONS } from "@domo/mcp-server";
import { parse, rpc } from "./client.js";

const cleanups: (() => void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function makeServer(): DomoMcpServer {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-copy-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const device = new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "allow_once" }));
  const server = createDomoMcpServer(device);
  cleanups.push(() => server.close());
  return server;
}

/** Every tool's description, keyed by name, as a client sees it. */
async function descriptions(server: DomoMcpServer): Promise<Record<string, string>> {
  const listed = parse(await rpc(server, "tools/list", {})).result?.tools as
    | { name: string; description: string }[]
    | undefined;
  expect(listed).toBeDefined();
  return Object.fromEntries(listed!.map((t) => [t.name, t.description]));
}

describe("the server tells the agent what it is for", () => {
  // The block rides both handshakes this server serves: `server/discover` for
  // 2026-07-28 callers and `initialize` for the 2025-era ones (claude.ai's
  // connector opens that way). A client may still drop it, which is why the
  // tool descriptions below carry the same point in compressed form.
  it("server/discover carries the instructions block", async () => {
    const result = parse(await rpc(makeServer(), "server/discover", {})).result as
      | { instructions?: string }
      | undefined;
    expect(result?.instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it("the instructions draw the boundary and say what to do with a pending handle", () => {
    // Whose machine this is, and whose it is not.
    expect(SERVER_INSTRUCTIONS).toMatch(/user's own Mac/);
    expect(SERVER_INSTRUCTIONS).toMatch(/your workspace/i);
    // The approval contract: say something, poll, do not ask twice.
    expect(SERVER_INSTRUCTIONS).toMatch(/pending handle/);
    expect(SERVER_INSTRUCTIONS).toMatch(/tell the user/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/get_result/);
    expect(SERVER_INSTRUCTIONS).toMatch(/do not re-issue/i);
  });

  // It is guidance to a model, not a grant. Nothing here may read as "ask
  // nicely and the bound widens" — the capability set is the bound.
  it("the instructions promise no capability", () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/without approval|no approval|always allowed/i);
  });
});

describe("every tool with a strong built-in alternative says whose Mac this is", () => {
  // The three where the agent's own tool is obvious, frictionless, and wrong:
  // its sandbox filesystem, its sandbox shell, its own web fetch.
  for (const tool of ["read_file", "write_file", "run_command", "browser_open"]) {
    it(`${tool} names the user's own machine`, async () => {
      expect(await descriptions(makeServer()).then((d) => d[tool])).toMatch(/user's own Mac/);
    });
  }

  it("read_file and write_file distinguish this Mac from the agent's workspace", async () => {
    const d = await descriptions(makeServer());
    expect(d.read_file).toMatch(/not your workspace/);
    expect(d.write_file).toMatch(/not for your own working files/);
  });

  it("run_command leads with when to choose it, not with the sandbox", async () => {
    const d = await descriptions(makeServer());
    // The sandbox is still stated — it is true and the agent needs it — but it
    // no longer opens the description, where it read as "this one is worse".
    expect(d.run_command).toMatch(/seatbelt sandbox/);
    expect(d.run_command.indexOf("own Mac")).toBeLessThan(d.run_command.indexOf("sandbox"));
  });

  // The differentiator that was missing entirely: a persistent profile and
  // vault fills. Stated as what it is — NOT as "already signed in", which
  // would be a promise this profile does not keep.
  it("browser_open says why it beats a plain web fetch, without overselling", async () => {
    const d = await descriptions(makeServer());
    expect(d.browser_open).toMatch(/profile persists/);
    expect(d.browser_open).toMatch(/vault/);
    expect(d.browser_open).toMatch(/one session at a time/i);
    expect(d.browser_open).not.toMatch(/already signed in/i);
  });
});

describe("the goal field says a human reads it", () => {
  it("names the reader, and does not offer access for a better answer", async () => {
    const listed = parse(await rpc(makeServer(), "tools/list", {})).result?.tools as
      | { name: string; inputSchema: { properties?: Record<string, { description?: string }> } }[]
      | undefined;
    const goal = listed?.find((t) => t.name === "read_file")?.inputSchema?.properties?.goal;
    expect(goal?.description).toMatch(/the user reads/i);
    // Goal text is display-only and never influences a decision path, so the
    // copy must not imply that explaining well earns anything.
    expect(goal?.description).not.toMatch(/more likely|grant|permission|access/i);
  });
});
