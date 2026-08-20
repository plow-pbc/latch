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
import { BrowserCrashedError, BrowserHost } from "@domo/device-core";

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
} {
  const events: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-bh-"));
  const host = new BrowserHost({
    command: ["node", FAKE],
    env,
    screenshotsDir: path.join(dir, "shots"),
    audit: (event: string, _fields: { [k: string]: JSONValue }) => events.push(event),
    ...extra,
  });
  hosts.push(host);
  return { host, events };
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
    const statuses = () => (host.takeFailedRequests() as { status: number }[]).map((r) => r.status);
    await host.sendAction({ action: "click", selector: "#blocked" });
    // Scripted: this one's refusal settles late, so it arrives on the viewer
    // poll — a reply nobody reads refusals off. Held, not dropped, is the whole
    // reason the buffer lives in this class.
    await host.sendAction({ action: "click", selector: "#blocked-later" });
    expect(await host.viewFrame()).not.toBeNull();
    await host.sendAction({ action: "click", selector: "#blocked" });
    // Five seen so far, and the poll-borne 401 sits in the middle where it
    // arrived rather than at either end.
    expect(statuses()).toEqual([429, 403, 401, 429, 403]);
    // Taken means taken: the next asker gets nothing.
    expect(host.takeFailedRequests()).toEqual([]);

    // Bounded, and it is the OLDEST that falls off: seven refusals, five kept —
    // the 401 armed first and the 403 behind it are what go.
    await host.sendAction({ action: "click", selector: "#blocked-later" });
    for (let i = 0; i < 3; i++) {
      await host.sendAction({ action: "click", selector: "#blocked" });
    }
    expect(statuses()).toEqual([429, 403, 429, 403, 429]);

    // And a late refusal still pending when the next one is scripted keeps its
    // place behind it rather than being lost — one ring, oldest last.
    await host.sendAction({ action: "click", selector: "#blocked-later" });
    await host.sendAction({ action: "click", selector: "#blocked" });
    expect(statuses()).toEqual([429, 403, 401]);
  });

  it("rejects pending on crash and lazily restarts", async () => {
    const { host, events } = makeHost({ CRASH_AFTER: "1" });
    let crashes = 0;
    host.onCrash = () => crashes++;
    await host.sendAction({ action: "click", selector: "#blocked" });
    await expect(host.sendAction({ action: "url" })).rejects.toThrow(BrowserCrashedError);
    expect(events).toContain("browser_crashed");
    // The session layer is told, so it can close its books.
    expect(crashes).toBe(1);
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

  it("bounds a hung action by actionTimeoutMs instead of blocking forever", async () => {
    const { host } = makeHost({ HANG_ACTION: "eval" }, { actionTimeoutMs: 300 });
    const started = Date.now();
    await expect(host.sendAction({ action: "eval", expression: "while(true){}" })).rejects.toThrow(
      /timed out/,
    );
    expect(Date.now() - started).toBeLessThan(3000);
    // A non-hung action on the same live browser still answers.
    expect((await host.sendAction({ action: "url" })).url).toBe("about:blank");
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
    expect(await host.viewFrame()).toBeNull();
    // The browser itself is still fine.
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
