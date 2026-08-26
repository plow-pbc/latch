/**
 * The wire log's one hard rule is that the credential never reaches the file —
 * it exists to be pasted into a bug report, so a leak here leaves the Mac.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loggingFetch, wireLogPath } from "../src/wireLog.js";

const CREDENTIAL = "plow_sk_device_do_not_leak";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-wirelog-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lines(home: string): Record<string, unknown>[] {
  return fs
    .readFileSync(wireLogPath(home), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const answering = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const post = (extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { authorization: `Bearer ${CREDENTIAL}`, ...extra },
  body: JSON.stringify({ chat_uid: "cht_1" }),
});

describe("the wire log", () => {
  it("records that a bearer was sent and never what it was", async () => {
    const home = tempHome();

    await loggingFetch(home, answering(200, {}))("https://api.plow.co/v1/chats", post());

    expect(lines(home)[0].authorization).toBe("bearer present");
    expect(fs.readFileSync(wireLogPath(home), "utf8")).not.toContain(CREDENTIAL);
  });

  it("writes no request or response body, ever", async () => {
    const home = tempHome();
    // What `GET /v1/chats` actually returns: other people's names and numbers.
    const chats = {
      data: [
        {
          uid: "cht_1",
          participants: [
            { type: "agent", line: { provider_key: "+15550100" } },
            { type: "member", display_name: "Ada Lovelace", provider_key: "+15550111" },
          ],
        },
      ],
    };

    await loggingFetch(home, answering(200, chats))("https://api.plow.co/v1/chats", post());

    const raw = fs.readFileSync(wireLogPath(home), "utf8");
    // This file is meant to be pasted into a bug report. Someone else's phone
    // number is the worst thing that could be in it.
    expect(raw).not.toContain("Ada Lovelace");
    expect(raw).not.toContain("+15550111");
    expect(raw).not.toContain("cht_1");
    expect(raw).not.toContain("chat_uid");
    // And the request body is gone with it.
    expect(raw).not.toContain("chat_uid");
    expect(lines(home)[0]).toMatchObject({ method: "POST", status: 200, detail: null });
  });

  it("keeps a session id out of the file even on a success", async () => {
    const home = tempHome();

    await loggingFetch(
      home,
      answering(200, { agent_id: "agent_1", session_id: "session_secret_identity" }),
    )("https://api.plow.co/v1/agents/cloud", post());

    expect(fs.readFileSync(wireLogPath(home), "utf8")).not.toContain("session_secret_identity");
  });

  it("scrubs a credential a server echoes back", async () => {
    const home = tempHome();

    await loggingFetch(
      home,
      answering(400, { detail: `token ${CREDENTIAL} is not valid` }),
    )("https://api.plow.co/v1/agents/cloud", post());


    const raw = fs.readFileSync(wireLogPath(home), "utf8");
    expect(raw).not.toContain(CREDENTIAL);
    expect(raw).toContain("[redacted]");
  });

  it("keeps the raw answer behind a friendly error", async () => {
    const home = tempHome();

    await loggingFetch(
      home,
      answering(503, { detail: "no capacity in region" }),
    )("https://api.plow.co/v1/agents/cloud", post());

    // The user is shown a friendly sentence; the server's own survives here.
    expect(lines(home)[0]).toMatchObject({
      status: 503,
      detail: "no capacity in region",
    });
  });

  it("appends, and leaves the response readable by its caller", async () => {
    const home = tempHome();
    const logging = loggingFetch(home, answering(200, { ok: true }));

    const first = await logging("https://api.plow.co/v1/chats", post());
    await logging("https://api.plow.co/v1/chats", post());

    expect(lines(home)).toHaveLength(2);
    // The log reads its copy through a clone.
    expect(await first.json()).toEqual({ ok: true });
  });

  it("starts over rather than growing without bound", async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(wireLogPath(home)), { recursive: true });
    fs.writeFileSync(wireLogPath(home), "x".repeat(3 * 1024 * 1024));

    await loggingFetch(home, answering(200, { ok: true }))(
      "https://api.plow.co/v1/chats",
      post(),
    );

    // A rolling account of recent exchanges, not an archive on someone's Mac.
    expect(lines(home)).toHaveLength(1);
  });

  it("never takes a request down with it", async () => {
    // An unwritable home: the log is diagnostics, and diagnostics must not be
    // the reason a call fails.
    const response = await loggingFetch("/nowhere/at/all", answering(200, { ok: true }))(
      "https://api.plow.co/v1/chats",
      post(),
    );

    expect(response.status).toBe(200);
  });
});
