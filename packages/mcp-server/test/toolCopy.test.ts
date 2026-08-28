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
import {
  BROWSING_SKILL,
  DeviceAgent,
  HeadlessPolicy,
  LIVE_WEB_ROUTING,
} from "@domo/device-core";
import {
  createDomoMcpServer,
  DomoMcpServer,
  MACOS_TOOLING,
  SERVER_IDENTITY,
  SERVER_INSTRUCTIONS,
  TOOLS,
} from "@domo/mcp-server";
import { parse, rpc } from "./client.js";
import { bareToolNames } from "./toolNames.js";

const cleanups: (() => void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function makeServer(options: { version?: string } = {}): DomoMcpServer {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-copy-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const device = new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "allow_once" }));
  const server = createDomoMcpServer(device, options);
  cleanups.push(() => server.close());
  return server;
}

/**
 * The 2025-era handshake, which is the only one that carries `serverInfo`.
 *
 * It answers SSE, and there is no opting out: the legacy binding refuses with
 * 406 unless the client accepts BOTH `application/json` and
 * `text/event-stream`, and having accepted both it picks the stream. So the
 * one frame is unwrapped here rather than by the shared `parse`, which serves
 * the modern per-request path every other test uses.
 */
async function initialize(server: DomoMcpServer): Promise<Record<string, unknown>> {
  const legacy = "2025-11-25";
  const response = await rpc(
    server,
    "initialize",
    { protocolVersion: legacy, capabilities: {}, clientInfo: { name: "t", version: "1" } },
    undefined,
    { protocolVersion: legacy },
  );
  expect(response.status, response.body).toBe(200);
  const data = response.body
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length);
  expect(data, `no SSE data frame in: ${response.body}`).toBeDefined();
  return ((JSON.parse(data!) as { result?: Record<string, unknown> }).result ?? {}) as Record<
    string,
    unknown
  >;
}

/** Every tool as a client sees it, with the metadata beside the description. */
async function listed(server: DomoMcpServer) {
  const tools = parse(await rpc(server, "tools/list", {})).result?.tools as
    | { name: string; title?: string; description: string; annotations?: Record<string, boolean> }[]
    | undefined;
  expect(tools).toBeDefined();
  return tools!;
}

/** Every tool's description, keyed by name, as a client sees it. */
async function descriptions(server: DomoMcpServer): Promise<Record<string, string>> {
  return Object.fromEntries((await listed(server)).map((t) => [t.name, t.description]));
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

  // Skills are per-user, per-Mac how-to guides an agent cannot otherwise know
  // — the discovery call has to be named, not just implied by its existence.
  it("the instructions route the agent to plow_list_skills", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/plow_list_skills/);
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

  // What this case owns is the vault fill and the WHICH-browser line. Browsing
  // AS the user — their profile, their logins — is pinned on LIVE_WEB_ROUTING,
  // which this description interpolates.
  it("plow_browser_open says why it beats a plain web fetch", async () => {
    const d = await descriptions(makeServer());
    expect(d.plow_browser_open).toMatch(/vault/);
    // Several browsers run at once, so the copy says which one the agent holds
    // rather than promising it is the only one.
    expect(d.plow_browser_open).toMatch(/session id you get back says WHICH browser/i);
    expect(d.plow_browser_open).not.toMatch(/one session at a time/i);
  });
});

describe("the goal field says a human reads it", () => {
  it("names the reader, and does not offer access for a better answer", async () => {
    const tools = parse(await rpc(makeServer(), "tools/list", {})).result?.tools as
      | { name: string; inputSchema: { properties?: Record<string, { description?: string }> } }[]
      | undefined;
    const goal = tools?.find((t) => t.name === "plow_read_file")?.inputSchema?.properties?.goal;
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

  // The skill and the server instructions are read by the same model in the
  // same breath; when they disagreed about who does general web reading, the
  // agent resolved it arbitrarily — the exact inconsistency this work exists to
  // remove.
  it("the skill description claims the live web", () => {
    expect(BROWSING_SKILL.description).toMatch(/reading the live web/i);
    expect(BROWSING_SKILL.description).not.toMatch(/any task that requires visiting/i);
  });
});

/**
 * Every string the manifest puts in front of a model.
 *
 * "Every" is load-bearing and this list has been short before. It missed tool
 * TITLES (a client shows `title` in preference to `name`, so a model skimming
 * a tool list reads them) and the skill BODY (`plow_read_skill` serves it in
 * full) — both of which the guards below are meant to cover. If you add a
 * string an agent can read, add it here; the guards are only as wide as this.
 */
function manifestStrings(): { where: string; text: string }[] {
  const out = [{ where: "instructions", text: SERVER_INSTRUCTIONS }];
  for (const tool of TOOLS) {
    out.push({ where: `${tool.name}.title`, text: tool.title });
    out.push({ where: `${tool.name}.description`, text: tool.description });
    const props =
      (tool.inputSchema as { properties?: Record<string, { description?: string }> })
        .properties ?? {};
    for (const [name, prop] of Object.entries(props)) {
      if (prop?.description) out.push({ where: `${tool.name}.${name}`, text: prop.description });
    }
  }
  out.push({ where: "skill.description", text: BROWSING_SKILL.description });
  out.push({ where: "skill.body", text: BROWSING_SKILL.body });
  out.push({ where: "serverInfo.title", text: SERVER_IDENTITY.title });
  out.push({ where: "serverInfo.description", text: SERVER_IDENTITY.description });
  return out;
}

describe("the handshake says what this server is", () => {
  // `serverInfo` rides `initialize` and ONLY `initialize` — the 2026-07-28
  // `server/discover` result carries no `Implementation` at all. So `title`,
  // `description` and `websiteUrl` reach 2025-era clients and no one else,
  // which is why the routing contract lives in the instructions block.
  it("initialize carries a titled, described identity", async () => {
    const info = (await initialize(makeServer())).serverInfo as Record<string, string> | undefined;
    expect(info?.name).toBe("plow-latch");
    expect(info?.title).toMatch(/Plow Latch/);
    // The one field MCP has for "what is this server FOR". It has to name
    // whose machine this is; an empty one was the whole finding.
    expect(info?.description).toMatch(/own Mac/i);
    expect(info?.websiteUrl).toMatch(/^https:\/\//);
  });

  it("reports the version it was given, and flags the default as a bug", async () => {
    const real = (await initialize(makeServer({ version: "1.2.3" }))).serverInfo as { version: string };
    expect(real.version).toBe("1.2.3");
    // A caller that forgets gets a value that reads as unset rather than as a
    // release — the hardcoded "0.1.0" hid exactly that for as long as it lived.
    const missing = (await initialize(makeServer())).serverInfo as { version: string };
    expect(missing.version).toBe("0.0.0-dev");
  });
});

describe("every tool says what kind of tool it is", () => {
  it("carries a title and annotations for every tool", async () => {
    for (const tool of await listed(makeServer())) {
      expect(tool.title, `${tool.name} has no title`).toBeTruthy();
      expect(typeof tool.annotations?.readOnlyHint, `${tool.name} has no readOnlyHint`).toBe(
        "boolean",
      );
    }
  });

  // Pinned as a set rather than per-tool: the failure mode worth catching is a
  // NEW tool that quietly defaults to looking harmless, and a per-tool loop
  // cannot see one that was never added to it.
  it.each([
    {
      hint: "readOnlyHint" as const,
      what: "cannot change this Mac",
      tools: [
        "plow_get_output",
        "plow_get_result",
        "plow_list_skills",
        "plow_read_file",
        "plow_read_skill",
        // list/describe only, and no tool here returns a vault value.
        "plow_vault",
      ],
    },
    {
      hint: "openWorldHint" as const,
      what: "reach the open internet",
      tools: ["plow_browser", "plow_browser_open", "plow_browser_request", "plow_run_command"],
    },
  ])("the tools that $what are exactly the ones marked $hint", async ({ hint, tools }) => {
    const marked = (await listed(makeServer()))
      .filter((t) => t.annotations?.[hint])
      .map((t) => t.name)
      .sort();
    expect(marked).toEqual([...tools].sort());
  });
});

describe("what the agent-facing copy must and must not say", () => {
  // The mechanism itself is pinned on LIVE_WEB_ROUTING by the seam test below;
  // what is this block's own is that the instructions name the tool and carry
  // the worked example — a concrete case moves a model where a rule does not,
  // and this one is the request that started the work.
  it("the instructions name the tool and give the worked example", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/plow_browser_open/);
    expect(SERVER_INSTRUCTIONS).toMatch(/reddit/i);
  });

  /**
   * Seam, not words. The live-web rule had three independent wordings and a
   * regex guard to keep them in step; one constant with three consumers means
   * the assertion is that they still consume it.
   */
  it("all three surfaces interpolate the one live-web routing sentence", async () => {
    expect(SERVER_INSTRUCTIONS).toContain(LIVE_WEB_ROUTING);
    expect((await descriptions(makeServer())).plow_browser_open).toContain(LIVE_WEB_ROUTING);
    expect(BROWSING_SKILL.description).toContain(LIVE_WEB_ROUTING);
  });

  /**
   * Content, not seam — its own case so a failure names what broke. Every
   * clause is a reason the agent's own fetch cannot answer a live-web
   * question, and each is separately droppable, so the case pins the set whole
   * rather than a representative.
   */
  it("the routing sentence names every advantage a plain fetch lacks", () => {
    for (const claim of [
      /own network/i,
      /datacenter address/i,
      /renders JavaScript/i,
      /copy of their own profile/i,
      /already signed in/i,
    ]) {
      expect(LIVE_WEB_ROUTING).toMatch(claim);
    }
  });

  /**
   * Pins the SEAM, not the words. Grepping the instructions for /mdfind/ was
   * the obvious assertion and it stopped meaning anything the moment one
   * constant fed both strings: dropping `${MACOS_TOOLING}` from
   * plow_run_command's description — the plausible edit when the mach-lookup
   * TODO forces a rewrite — would ship green while the tool that actually runs
   * the commands named no tooling at all.
   */
  it("both copy homes interpolate the one tooling list", async () => {
    expect(SERVER_INSTRUCTIONS).toContain(MACOS_TOOLING);
    expect((await descriptions(makeServer())).plow_run_command).toContain(MACOS_TOOLING);
  });

  /**
   * Content, not seam — its own case so a failure names what broke. Every tool
   * here was RUN under the generated profile; executor.ts's mach-lookup note
   * governs the same set, so dropping the clipboard pair must not ship green.
   */
  it("the tooling list names every tool verified under the profile", () => {
    for (const tool of ["mdfind", "sips", "pbcopy", "pbpaste"]) {
      expect(MACOS_TOOLING).toContain(tool);
    }
  });

  /**
   * Every fault that must not appear ANYWHERE a model reads, in one table.
   * `offends` is a predicate rather than a regex so the bare-tool-name sweep —
   * a function call, not a match — belongs in the same table.
   *
   * `open` was removed from the tooling copy alongside `osascript` but is not
   * pinned here: too common an English word to assert against prose.
   *
   * An "already signed in" row lived here and is GONE, deliberately. It was
   * written when a session opened on a persistent-but-shared profile, where the
   * phrase promised something no particular site kept. Sessions now start on a
   * copy of the user's own profile, so it is the honest description — and
   * `LIVE_WEB_ROUTING`, which every surface interpolates, is asserted to make
   * it.
   */
  const FORBIDDEN: {
    what: string;
    why: string;
    offends: (text: string) => boolean;
    except?: string[];
  }[] = [
    {
      what: "routes web reading to the agent's own tools",
      why: "the sentence this whole surface exists to remove; it had three homes",
      offends: (text) =>
        /general web reading|which your own tools do faster|your own tools, which are faster/i.test(
          text,
        ),
    },
    {
      what: "prescribes tooling the sandbox denies",
      why: "(deny default) grants no appleevent-send and the app ships no automation entitlement",
      offends: (text) => /osascript|screencapture|shortcuts/i.test(text),
      // The apple_events capability's own description is the one place
      // osascript is meant to appear: it is exactly what grants appleevent-send
      // when the approver allows it, so naming it here is honest, not a
      // prescription the sandbox then denies.
      except: ["plow_run_command.apple_events"],
    },
    {
      what: "names a tool without its plow_ prefix",
      // Not just the skill: #46's pending-handle note shipped "poll
      // get_result" an hour before that rename landed, and nothing caught it.
      why: "a bare tool name is a call an agent cannot make",
      offends: (text) => bareToolNames(text).length > 0,
    },
  ];

  it.each(FORBIDDEN)("no manifest string $what", ({ offends, why, except }) => {
    for (const { where, text } of manifestStrings()) {
      if (except?.includes(where)) continue;
      expect(offends(text), `${where}: ${why}`).toBe(false);
    }
  });
});
