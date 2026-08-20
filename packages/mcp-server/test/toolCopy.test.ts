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
import { BROWSING_SKILL, DeviceAgent, HeadlessPolicy } from "@domo/device-core";
import {
  createDomoMcpServer,
  DomoMcpServer,
  SERVER_INSTRUCTIONS,
  TOOLS,
} from "@domo/mcp-server";
import { parse, rpc } from "./client.js";
import { bareToolNames } from "./toolNames.js";

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
    expect(SERVER_INSTRUCTIONS).toMatch(/plow_get_result/);
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
  for (const tool of ["plow_read_file", "plow_write_file", "plow_run_command", "plow_browser_open"]) {
    it(`${tool} names the user's own machine`, async () => {
      expect(await descriptions(makeServer()).then((d) => d[tool])).toMatch(/user's own Mac/);
    });
  }

  it("plow_read_file and plow_write_file distinguish this Mac from the agent's workspace", async () => {
    const d = await descriptions(makeServer());
    expect(d.plow_read_file).toMatch(/not your workspace/);
    expect(d.plow_write_file).toMatch(/not for your own working files/);
  });

  it("plow_run_command leads with when to choose it, not with the sandbox", async () => {
    const d = await descriptions(makeServer());
    // The sandbox is still stated — it is true and the agent needs it — but it
    // no longer opens the description, where it read as "this one is worse".
    expect(d.plow_run_command).toMatch(/seatbelt sandbox/);
    expect(d.plow_run_command.indexOf("own Mac")).toBeLessThan(d.plow_run_command.indexOf("sandbox"));
  });

  // The differentiator: it browses AS the user — their profile, their logins —
  // and can fill from their vault. Both are things a plain web fetch cannot do.
  it("plow_browser_open says why it beats a plain web fetch", async () => {
    const d = await descriptions(makeServer());
    // The Mac is one person's, and a session opens on a copy of their profile,
    // so "already signed in" is now the honest promise rather than an oversell.
    expect(d.plow_browser_open).toMatch(/already signed in/i);
    expect(d.plow_browser_open).toMatch(/vault/);
    // Several browsers run at once, so the copy says which one the agent holds
    // rather than promising it is the only one.
    expect(d.plow_browser_open).toMatch(/session id you get back says WHICH browser/i);
    expect(d.plow_browser_open).not.toMatch(/one session at a time/i);
  });
});

describe("the goal field says a human reads it", () => {
  it("names the reader, and does not offer access for a better answer", async () => {
    const listed = parse(await rpc(makeServer(), "tools/list", {})).result?.tools as
      | { name: string; inputSchema: { properties?: Record<string, { description?: string }> } }[]
      | undefined;
    const goal = listed?.find((t) => t.name === "plow_read_file")?.inputSchema?.properties?.goal;
    expect(goal?.description).toMatch(/the user reads/i);
    // Goal text is display-only and never influences a decision path, so the
    // copy must not imply that explaining well earns anything.
    expect(goal?.description).not.toMatch(/more likely|grant|permission|access/i);
  });
});

describe("the browsing skill agrees with the tools it documents", () => {
  /**
   * EVERY example call in the skill body, as (tool, property names).
   *
   * `matchAll`, not `exec`. The first version of this used `exec` and so
   * checked only the FIRST example per tool — which is exactly how five stale
   * tool names shipped in this file while this test stayed green. A guard that
   * stops at the first match guards the first match.
   */
  function examples(): { tool: string; props: string[] }[] {
    const out: { tool: string; props: string[] }[] = [];
    for (const m of BROWSING_SKILL.body.matchAll(/\b(plow_[a-z_]+) \{([^}]*)\}/g)) {
      const props = m[2]
        .replace(/"[^"]*"/g, "") // drop string contents: they hold dots and commas
        .split(",")
        .map((part) => part.split(":")[0].replace(/[^a-z_]/g, ""))
        .filter((name) => name.length > 0 && name !== "true" && name !== "false");
      out.push({ tool: m[1], props });
    }
    return out;
  }

  // `device` survived in the examples long after the broker that needed it was
  // removed, and every tool schema is additionalProperties:false — so an agent
  // following the guide verbatim got a validation error on its first call. The
  // guide is only worth publishing if the calls in it actually run.
  it("every example calls a tool that exists, with properties its schema declares", () => {
    const found = examples();
    expect(found.length).toBeGreaterThan(3);
    for (const { tool, props } of found) {
      const spec = TOOLS.find((t) => t.name === tool);
      expect(spec, `the skill calls ${tool}, which is not a tool`).toBeDefined();
      const declared = Object.keys(
        (spec!.inputSchema as { properties: Record<string, unknown> }).properties,
      );
      for (const prop of props) {
        expect(declared, `${tool} has no '${prop}'`).toContain(prop);
      }
    }
  });

  it("names no tool without the plow_ prefix", () => {
    expect(bareToolNames(BROWSING_SKILL.body)).toEqual([]);
  });

  // The skill and the server instructions are read by the same model in the
  // same breath; when they disagreed about who does general web reading, the
  // agent resolved it arbitrarily — the exact inconsistency this work exists to
  // remove.
  it("the skill description does not claim general web reading", () => {
    expect(BROWSING_SKILL.description).toMatch(/general web reading belongs in your own tools/i);
    expect(BROWSING_SKILL.description).not.toMatch(/any task that requires visiting/i);
  });
});

/** Every string the manifest puts in front of a model. */
function manifestStrings(): { where: string; text: string }[] {
  const out = [{ where: "instructions", text: SERVER_INSTRUCTIONS }];
  for (const tool of TOOLS) {
    out.push({ where: `${tool.name}.description`, text: tool.description });
    const props =
      (tool.inputSchema as { properties?: Record<string, { description?: string }> })
        .properties ?? {};
    for (const [name, prop] of Object.entries(props)) {
      if (prop?.description) out.push({ where: `${tool.name}.${name}`, text: prop.description });
    }
  }
  out.push({ where: "skill.description", text: BROWSING_SKILL.description });
  return out;
}

describe("nothing an agent reads names a tool by its old name", () => {
  // Not just the skill: #46's pending-handle note shipped "poll get_result"
  // an hour before this rename landed, and nothing here would have caught it.
  it("no manifest string carries a bare tool name", () => {
    for (const { where, text } of manifestStrings()) {
      expect(bareToolNames(text), `${where} names a tool without plow_`).toEqual([]);
    }
  });
});
