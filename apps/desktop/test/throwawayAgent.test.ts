/**
 * THROWAWAY, with the file it covers. Four paths only — create, delete, the
 * synchronous response, and a failure — because this surface goes away when
 * `GET /v1/agents/cloud` and `chats:use` deploy.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  THROWAWAY_AGENT_CAPABILITIES,
  ThrowawayAgent,
  ThrowawayAgentsApi,
  throwawayLoggingFetch,
  throwawayLogPath,
} from "../src/throwawayAgent.js";
import { CloudAgentResource } from "../src/cloudAgents.js";
import { CLOUD_AGENT_PROVIDER } from "../src/cloudAgentState.js";
import { PlowApiError } from "../src/plowApi.js";
import { loadSettings, saveSettings } from "../src/settings.js";

const CREDENTIAL = "plow_sk_device_do_not_leak";
const SESSION = "session_never_leaves_the_main_process";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempHome(overrides: Partial<ReturnType<typeof loadSettings>> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-throwaway-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = loadSettings(dir);
  settings.relayCredential = CREDENTIAL;
  settings.provisionedChatUid = "cht_1";
  settings.provisionedChatLabel = "+15550100 · Ada";
  settings.activationSendTo = "+15550100";
  saveSettings(dir, { ...settings, ...overrides });
  return dir;
}

function resource(overrides: Partial<CloudAgentResource> = {}): CloudAgentResource {
  return {
    agentId: "agent_1",
    chatUid: "cht_1",
    url: "https://agent.example/internal",
    provider: "exe:hermes",
    name: "Kitchen agent",
    status: "active",
    failureReason: null,
    createdAt: "2026-08-25T09:00:00Z",
    sessionId: SESSION,
    ...overrides,
  };
}

function fakes(opts: {
  create?: () => Promise<CloudAgentResource>;
  remove?: () => Promise<void>;
} = {}) {
  const created: Array<{
    chatUid: string;
    name?: string;
    scopes?: string[];
    provider?: string | null;
  }> = [];
  const deleted: string[] = [];
  const agents: ThrowawayAgentsApi = {
    async create(credential, request) {
      expect(credential).toBe(CREDENTIAL);
      created.push({
        chatUid: request.chatUid,
        name: request.name,
        scopes: request.scopes,
        provider: request.provider,
      });
      return opts.create ? opts.create() : resource();
    },
    async delete(credential, agentId) {
      expect(credential).toBe(CREDENTIAL);
      deleted.push(agentId);
      if (opts.remove) await opts.remove();
    },
  };
  return { agents, created, deleted };
}

const build = (home: string, f: ReturnType<typeof fakes>) =>
  new ThrowawayAgent({ agents: f.agents, home });

describe("the card before anything exists", () => {
  it("offers the chat and the number activation left behind", () => {
    const state = build(tempHome(), fakes()).state();

    expect(state).toMatchObject({
      chatUid: "cht_1",
      chatLabel: "+15550100 · Ada",
      sendTo: "+15550100",
      ready: true,
      busy: false,
      error: null,
      agent: null,
    });
  });

  it("is not ready on a Mac whose activation left no chat", () => {
    const state = build(tempHome({ provisionedChatUid: "" }), fakes()).state();

    expect(state.ready).toBe(false);
  });

  it("says what the agent will be able to do, including the two that matter", () => {
    // The person pressing the button is the one deciding whether this is
    // acceptable, so the reach onto this Mac and the spending are both stated.
    expect(THROWAWAY_AGENT_CAPABILITIES.join(" ")).toContain("that one chat, and no other");
    expect(THROWAWAY_AGENT_CAPABILITIES.join(" ")).toContain("approval and sandbox rules");
    expect(THROWAWAY_AGENT_CAPABILITIES.join(" ")).toContain("inference");
  });
});

describe("Get an agent", () => {
  it("creates one in the activation chat and keeps it across a restart", async () => {
    const home = tempHome();
    const f = fakes();

    const state = await build(home, f).create("Kitchen agent");

    expect(f.created).toEqual([
      { chatUid: "cht_1", name: "Kitchen agent", scopes: undefined, provider: "exe:hermes" },
    ]);
    expect(state.agent).toEqual({
      agentId: "agent_1",
      provider: "exe:hermes",
      createdAt: "2026-08-25T09:00:00Z",
      status: "active",
    });
    expect(state.error).toBeNull();
    // A second instance over the same home — what a relaunch is.
    expect(build(home, fakes()).state().agent?.agentId).toBe("agent_1");
  });

  it("sends no scopes, so plow mints its own default", async () => {
    const f = fakes();

    await build(tempHome(), f).create("Kitchen agent");

    // The capability copy describes that default. Sending a set here would be
    // this app deciding what the agent may do, which it has no basis to do.
    expect(f.created[0].scopes).toBeUndefined();
  });

  it("names the provider, because plow's default one 503s in prod", async () => {
    const f = fakes();

    await build(tempHome(), f).create("Kitchen agent");

    expect(f.created[0].provider).toBe(CLOUD_AGENT_PROVIDER);
    expect(f.created[0].provider).toBe("exe:hermes");
  });

  it("takes the synchronous answer as final and never polls", async () => {
    let calls = 0;
    const f = fakes({
      create: async () => {
        calls += 1;
        return resource({ status: "active" });
      },
    });

    const state = await build(tempHome(), f).create("Kitchen agent");

    // Prod's create returns the finished resource. One request, and whatever
    // it says is the status — there is no progress to report and nothing to
    // ask again for.
    expect(calls).toBe(1);
    expect(state.agent?.status).toBe("active");
    expect(state.busy).toBe(false);
  });

  it("records a non-terminal answer as it stands rather than waiting on it", async () => {
    const f = fakes({ create: async () => resource({ status: "provisioning" }) });

    const state = await build(tempHome(), f).create("Kitchen agent");

    expect(state.agent?.status).toBe("provisioning");
    expect(state.busy).toBe(false);
  });

  it("shows the server's own words when it refuses", async () => {
    const home = tempHome();
    const f = fakes({
      create: async () => {
        throw new PlowApiError("http", "chat 'cht_1' not found.", 404);
      },
    });

    const state = await build(home, f).create("Kitchen agent");

    // The API team writes `detail` for humans; passing it through beats
    // inventing a sentence about someone else's failure.
    expect(state.error).toBe("chat 'cht_1' not found.");
    expect(state.agent).toBeNull();
    expect(build(home, fakes()).state().agent).toBeNull();
  });

  it("refuses without a chat, and asks nothing of Plow", async () => {
    const f = fakes();

    const state = await build(tempHome({ provisionedChatUid: "" }), f).create("Kitchen agent");

    expect(f.created).toEqual([]);
    expect(state.error).toBe("This Mac has no chat yet. Re-activate it to get one.");
  });
});

describe("Delete", () => {
  it("removes it and forgets it", async () => {
    const home = tempHome();
    const f = fakes();
    const card = build(home, f);
    await card.create("Kitchen agent");

    const state = await card.remove();

    expect(f.deleted).toEqual(["agent_1"]);
    expect(state.agent).toBeNull();
    expect(build(home, fakes()).state().agent).toBeNull();
  });

  it("keeps the record when the delete fails", async () => {
    const home = tempHome();
    const f = fakes({
      remove: async () => {
        throw new PlowApiError("http", "Plow returned 500.", 500);
      },
    });
    const card = build(home, f);
    await card.create("Kitchen agent");

    const state = await card.remove();

    // Forgetting here would leave an agent nobody can see and nobody can
    // remove — the card is the only handle on it.
    expect(state.error).toBe("Plow returned 500.");
    expect(state.agent?.agentId).toBe("agent_1");
  });
});

describe("the credential boundary", () => {
  it("marshals no credential, session id or provider URL", async () => {
    const home = tempHome();
    const state = await build(home, fakes()).create("Kitchen agent");

    const marshalled = JSON.stringify(state);
    expect(marshalled).not.toContain(CREDENTIAL);
    expect(marshalled).not.toContain(SESSION);
    expect(marshalled).not.toContain("agent.example");
    // Nor does what is written to disk.
    expect(fs.readFileSync(path.join(home, "app/throwaway-agent.json"), "utf8")).not.toContain(
      SESSION,
    );
  });
});

describe("the wire log", () => {
  function lines(home: string): Record<string, unknown>[] {
    return fs
      .readFileSync(throwawayLogPath(home), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** A fetch that answers whatever the test wants, as the real client sees it. */
  function answering(answer: { status: number; body: unknown }) {
    return async () =>
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
  }

  it("writes one line per exchange, with what the API team needs", async () => {
    const home = tempHome();
    const logging = throwawayLoggingFetch(
      home,
      answering({ status: 202, body: { agent_id: "agent_1" } }),
    );

    await logging("https://api.plow.co/v1/agents/cloud", {
      method: "POST",
      headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_uid: "cht_1" }),
    });

    const [entry] = lines(home);
    expect(entry).toMatchObject({
      method: "POST",
      url: "https://api.plow.co/v1/agents/cloud",
      requestBody: { chat_uid: "cht_1" },
      status: 202,
      responseBody: { agent_id: "agent_1" },
    });
    expect(typeof entry.elapsedMs).toBe("number");
    expect(entry.at).toMatch(/^\d{4}-/);
  });

  it("records that a bearer was sent and never what it was", async () => {
    const home = tempHome();
    const logging = throwawayLoggingFetch(home, answering({ status: 200, body: {} }));

    await logging("https://api.plow.co/v1/agents/cloud", {
      method: "POST",
      headers: { authorization: `Bearer ${CREDENTIAL}` },
      body: "{}",
    });

    expect(lines(home)[0].authorization).toBe("bearer present");
    expect(fs.readFileSync(throwawayLogPath(home), "utf8")).not.toContain(CREDENTIAL);
  });

  it("scrubs a credential a server echoes back", async () => {
    const home = tempHome();
    const logging = throwawayLoggingFetch(
      home,
      answering({ status: 400, body: { detail: `token ${CREDENTIAL} is not valid` } }),
    );

    await logging("https://api.plow.co/v1/agents/cloud", {
      method: "POST",
      headers: { authorization: `Bearer ${CREDENTIAL}` },
      body: "{}",
    });

    // This file is meant to be pasted into a bug report, so an echo here
    // leaves the Mac entirely.
    const raw = fs.readFileSync(throwawayLogPath(home), "utf8");
    expect(raw).not.toContain(CREDENTIAL);
    expect(raw).toContain("[redacted]");
  });

  it("keeps the failure the user was spared", async () => {
    const home = tempHome();
    const f = fakes();
    // The client the card actually uses, wired through the log.
    const { CloudAgentsClient } = await import("../src/cloudAgents.js");
    const client = new CloudAgentsClient(
      "https://api.plow.co",
      throwawayLoggingFetch(
        home,
        answering({ status: 503, body: { detail: "no capacity in region" } }),
      ),
    );
    const card = new ThrowawayAgent({ agents: client, home });
    void f;

    const state = await card.create("Kitchen agent");

    expect(state.error).toBe("no capacity in region");
    // And the raw answer survives the friendly sentence.
    expect(lines(home)[0]).toMatchObject({
      status: 503,
      responseBody: { detail: "no capacity in region" },
    });
  });

  it("appends rather than replacing, and leaves the response readable", async () => {
    const home = tempHome();
    const logging = throwawayLoggingFetch(
      home,
      answering({ status: 200, body: { ok: true } }),
    );

    const first = await logging("https://api.plow.co/v1/agents/cloud", {
      method: "GET",
      headers: { authorization: `Bearer ${CREDENTIAL}` },
    });
    await logging("https://api.plow.co/v1/agents/cloud", {
      method: "GET",
      headers: { authorization: `Bearer ${CREDENTIAL}` },
    });

    expect(lines(home)).toHaveLength(2);
    // The log reads the body through a clone, so the caller still gets one.
    expect(await first.json()).toEqual({ ok: true });
  });

  it("tells the card where the log is", () => {
    const home = tempHome();
    expect(build(home, fakes()).state().logPath).toBe(throwawayLogPath(home));
  });
});
