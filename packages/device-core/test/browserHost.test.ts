/**
 * BrowserHost supervision against the fake stdio server: ready handshake, id
 * correlation, garbage tolerance, crash → reject + lazy restart, circuit
 * breaker, start timeout, and group shutdown.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSONValue } from "@domo/protocol";
import { AuditLog, BrowserCrashedError, BrowserHost } from "@domo/device-core";

const FAKE = fileURLToPath(new URL("../../../e2e/fixtures/fakeBrowserServer.cjs", import.meta.url));

const hosts: BrowserHost[] = [];
afterEach(async () => {
  while (hosts.length) await hosts.pop()!.shutdown();
});

function makeHost(
  env: Record<string, string> = {},
  extra: Partial<{ startTimeoutMs: number; actionTimeoutMs: number }> = {},
): {
  host: BrowserHost;
  events: string[];
  records: { event: string; fields: { [k: string]: JSONValue } }[];
  auditFile: string;
} {
  const events: string[] = [];
  const records: { event: string; fields: { [k: string]: JSONValue } }[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-bh-"));
  const audit = new AuditLog(path.join(dir, "audit.ndjson"));
  const host = new BrowserHost({
    command: ["node", FAKE],
    env,
    screenshotsDir: path.join(dir, "shots"),
    audit: (event: string, fields: { [k: string]: JSONValue }) => {
      events.push(event);
      records.push({ event, fields });
      audit.record(event, fields);
    },
    ...extra,
  });
  hosts.push(host);
  return { host, events, records, auditFile: audit.file };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(processExists(pid)).toBe(false);
}

describe("BrowserHost", () => {
  it("starts lazily, reports ready, and correlates responses by id", async () => {
    const { host, events } = makeHost();
    expect(host.running).toBe(false);
    const [a, b] = await Promise.all([
      host.sendAction({ action: "goto", url: "https://one.example/" }),
      host.sendAction({ action: "text" }),
    ]);
    expect(a.url).toBe("https://one.example/");
    expect(typeof b.text).toBe("string");
    expect(host.running).toBe(true);
    expect(host.browserVersion).toBe("fake-152.0.4");
    expect(events).toContain("browser_started");
  });

  it("tolerates garbage on the protocol channel", async () => {
    const { host } = makeHost({ GARBAGE: "1" });
    const r = await host.sendAction({ action: "title" });
    expect(r.title).toBe("blank");
  });

  it("holds refused requests across replies, newest first and bounded", async () => {
    // The reason the buffer lives here: most of what asks the browser anything
    // is the device's own doing — the ~1/s viewer poll, the popup sweep, a
    // credential fill's locate — and whichever was in flight would otherwise be
    // the one that consumed a 429 and dropped it.
    const { host } = makeHost();
    const takeStatuses = () => (host.takeFailedRequests() as { status: number }[]).map((r) => r.status);
    await host.sendAction({ action: "click", selector: "#blocked" });
    // Scripted: this one's refusal settles late, so it arrives on the viewer
    // poll — a reply nobody reads refusals off. Held, not dropped, is the whole
    // reason the buffer lives in this class.
    await host.sendAction({ action: "click", selector: "#blocked-later" });
    expect(await host.viewFrame()).not.toBeNull();
    await host.sendAction({ action: "click", selector: "#blocked" });
    // The poll-borne 401 sits where it arrived rather than at either end.
    expect(takeStatuses()).toEqual([429, 403, 404, 503, 401]);
    // Taken means taken: the next asker gets nothing.
    expect(host.takeFailedRequests()).toEqual([]);

    // Bounded, and it is the OLDEST that falls off: ten refusals, five kept.
    await host.sendAction({ action: "click", selector: "#blocked-later" });
    for (let i = 0; i < 3; i++) {
      await host.sendAction({ action: "click", selector: "#blocked" });
    }
    expect(takeStatuses()).toEqual([429, 403, 404, 503, 429]);

    // And a late refusal still pending when the next one is scripted keeps its
    // place behind it rather than being lost — one ring, oldest last.
    await host.sendAction({ action: "click", selector: "#blocked-later" });
    await host.sendAction({ action: "click", selector: "#blocked" });
    expect(takeStatuses()).toEqual([429, 403, 404, 503, 401]);
  });

  it("rejects pending on crash and lazily restarts", async () => {
    const { host, events } = makeHost({ CRASH_AFTER: "1" });
    // What the dying browser said last, as the session sees it: the notice is
    // where the books are closed, so the line has to be there by then.
    let heldAtCrash: unknown[] = [];
    let crashes = 0;
    host.onCrash = () => {
      crashes++;
      heldAtCrash = host.takeFailedRequests();
    };
    await host.sendAction({ action: "click", selector: "#blocked" });
    await expect(host.sendAction({ action: "url" })).rejects.toThrow(BrowserCrashedError);
    expect(crashes).toBe(1);
    expect(events).toContain("browser_crashed");
    // Its last word — a 599 nothing else here emits — is there, and newest
    // first. The fixture puts a beat between the line and the death (its
    // CRASH_LINE_BEAT_MS) so this is about the contract and not about which
    // pending event libuv drains first — a flake here means the beat was too
    // short for a stalled box, not that the device regressed. In production
    // that order is the kernel's, and every mechanism tried for taking it out
    // of the kernel's hands cost more than the line it saved.
    expect((heldAtCrash as { status: number }[])[0]).toMatchObject({ status: 599 });
    // Next action restarts a fresh server (state reset to about:blank), and a
    // new browser saw none of the dead one's traffic.
    const r = await host.sendAction({ action: "url" });
    expect(r.url).toBe("about:blank");
    expect(host.takeFailedRequests()).toEqual([]);
  });

  it("trips the circuit breaker after repeated crashes", async () => {
    const { host } = makeHost({ CRASH_AFTER: "0" });
    for (let i = 0; i < 3; i++) {
      await expect(host.sendAction({ action: "url" })).rejects.toThrow();
    }
    await expect(host.sendAction({ action: "url" })).rejects.toThrow(/giving up/);
  });

  it("kills and audits a browser whose action reaches actionTimeoutMs", async () => {
    const { host, records, auditFile } = makeHost(
      { HANG_ACTION: "eval" },
      { actionTimeoutMs: 300 },
    );
    await host.sendAction({ action: "goto", url: "https://one.example/" });
    const firstPid = records.find((r) => r.event === "browser_started")!.fields.pid;
    let crashed!: () => void;
    const crash = new Promise<void>((resolve) => { crashed = resolve; });
    host.onCrash = crashed;
    const started = Date.now();
    await expect(host.sendAction({ action: "eval", expression: "while(true){}" })).rejects.toThrow(
      /timed out/,
    );
    expect(Date.now() - started).toBeLessThan(3000);
    await crash;
    expect(host.running).toBe(false);
    expect(records.find((r) => r.event === "browser_crashed")?.fields.reason)
      .toBe("action_timeout");
    const audit = fs.readFileSync(auditFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { event: string; reason?: string });
    expect(audit.find((entry) => entry.event === "browser_crashed")?.reason)
      .toBe("action_timeout");

    // The next action gets a fresh browser, not a reply queued behind the
    // action the old server never answered.
    expect((await host.sendAction({ action: "url" })).url).toBe("about:blank");
    const startedPids = records
      .filter((r) => r.event === "browser_started")
      .map((r) => r.fields.pid);
    expect(startedPids).toHaveLength(2);
    expect(startedPids[1]).not.toBe(firstPid);
  });

  it("kills the timed-out server's whole process group", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-bh-tree-"));
    const pidLog = path.join(dir, "child.pid");
    const { host, records } = makeHost(
      { HANG_ACTION: "eval", FAKE_CHILD_PID_LOG: pidLog },
      { actionTimeoutMs: 300 },
    );
    await host.ensureReady();
    const serverPid = Number(records.find((r) => r.event === "browser_started")!.fields.pid);
    const childPid = Number(fs.readFileSync(pidLog, "utf8"));
    expect(processExists(serverPid)).toBe(true);
    expect(processExists(childPid)).toBe(true);

    let crashed!: () => void;
    const crash = new Promise<void>((resolve) => { crashed = resolve; });
    host.onCrash = crashed;
    await expect(host.sendAction({ action: "eval", expression: "while(true){}" }))
      .rejects.toThrow(/timed out/);
    await crash;
    await waitForProcessExit(serverPid);
    await waitForProcessExit(childPid);
  });

  it("ensureReady starts the browser up front (warm before the first action)", async () => {
    const { host, events } = makeHost();
    await host.ensureReady();
    expect(host.running).toBe(true);
    expect(events).toContain("browser_started");
  });

  it("fails fast when the server never becomes ready", async () => {
    const { host } = makeHost({ NO_READY: "1" }, { startTimeoutMs: 500 });
    await expect(host.sendAction({ action: "url" })).rejects.toThrow(/did not become ready/);
  });

  it("viewFrame never starts the browser: null while not running", async () => {
    const { host } = makeHost();
    expect(await host.viewFrame()).toBeNull();
    expect(host.running).toBe(false);
  });

  it("viewFrame returns a frame from a running browser", async () => {
    const { host } = makeHost();
    await host.ensureReady();
    const frame = await host.viewFrame();
    expect(frame).not.toBeNull();
    expect(Buffer.from(frame!.dataB64, "base64").toString()).toBe("fake-view-jpeg");
    expect(frame!.mime).toBe("image/jpeg");
    expect(frame!.url).toBe("about:blank");
  });

  it("viewFrame is best-effort: a hung view action yields null, not a throw", async () => {
    const { host } = makeHost({ HANG_ACTION: "view" }, { actionTimeoutMs: 300 });
    await host.ensureReady();
    let crashed!: () => void;
    const crash = new Promise<void>((resolve) => { crashed = resolve; });
    host.onCrash = crashed;
    expect(await host.viewFrame()).toBeNull();
    await crash;
    // A raw host can start again after teardown; BrowserSessions closes its
    // owning session from onCrash instead.
    expect((await host.sendAction({ action: "url" })).url).toBe("about:blank");
  });

  it("shutdown quits the server and audits browser_stopped", async () => {
    const { host, events } = makeHost();
    await host.sendAction({ action: "url" });
    await host.shutdown();
    expect(host.running).toBe(false);
    expect(events).toContain("browser_stopped");
    await expect(host.sendAction({ action: "url" })).rejects.toThrow(/shut down/);
  });
});
