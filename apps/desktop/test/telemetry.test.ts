/**
 * Telemetry is an outbound surface, so its tests are about what NEVER leaves
 * the Mac as much as what does: the audit allowlist fails closed, error text
 * is scrubbed of the credential and the home path, and the opt-out and the
 * missing-key cases send nothing at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLog } from "@domo/device-core";
import {
  resolveTelemetryConfig,
  Telemetry,
  TelemetryProps,
  TelemetrySink,
  telemetryMaySend,
} from "../src/telemetry.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-telemetry-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

class FakeSink implements TelemetrySink {
  captured: { distinctId: string; event: string; properties: Record<string, unknown> }[] = [];
  sent: { distinctId: string; event: string; properties: Record<string, unknown> }[] = [];
  shutdowns = 0;
  capture(message: { distinctId: string; event: string; properties: Record<string, unknown> }): void {
    this.captured.push(message);
  }
  async sendNow(message: { distinctId: string; event: string; properties: Record<string, unknown> }): Promise<void> {
    this.sent.push(message);
  }
  async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }
  exceptions() {
    return this.sent.filter((c) => c.event === "$exception");
  }
}

function makeTelemetry(overrides: {
  home?: string;
  sink?: TelemetrySink | null;
  enabled?: boolean;
  accountUid?: string;
  secrets?: string[];
  ownerHome?: string;
} = {}): { telemetry: Telemetry; sink: FakeSink; home: string } {
  const home = overrides.home ?? tempHome();
  const sink = new FakeSink();
  const telemetry = new Telemetry({
    home,
    sink: overrides.sink === undefined ? sink : overrides.sink,
    enabled: () => overrides.enabled ?? true,
    accountUid: () => overrides.accountUid ?? "",
    secrets: () => overrides.secrets ?? [],
    ownerHome: overrides.ownerHome ?? "/Users/owner",
    baseProps: { app_version: "1.2.3", packaged: true },
  });
  return { telemetry, sink, home };
}

describe("resolveTelemetryConfig", () => {
  it("gives a from-source run no key, so dev churn reports nothing", () => {
    const config = resolveTelemetryConfig({ env: {}, packaged: false });
    expect(config.apiKey).toBe("");
  });

  it("lets DOMO_POSTHOG_KEY and DOMO_POSTHOG_HOST override, packaged or not", () => {
    const config = resolveTelemetryConfig({
      env: { DOMO_POSTHOG_KEY: "phc_test", DOMO_POSTHOG_HOST: "https://e.example.com" },
      packaged: false,
    });
    expect(config.apiKey).toBe("phc_test");
    expect(config.host).toBe("https://e.example.com");
  });

  it("defaults the host to PostHog US ingestion", () => {
    const config = resolveTelemetryConfig({ env: {}, packaged: true });
    expect(config.host).toBe("https://us.i.posthog.com");
  });
});

describe("usage events", () => {
  it("stays silent until setup has recorded the owner's choice", () => {
    expect(telemetryMaySend({ setupComplete: false, telemetryEnabled: true })).toBe(false);
    expect(telemetryMaySend({ setupComplete: true, telemetryEnabled: false })).toBe(false);
    expect(telemetryMaySend({ setupComplete: true, telemetryEnabled: true })).toBe(true);
  });

  it("stamps base props and the event's own props", () => {
    const { telemetry, sink } = makeTelemetry();
    telemetry.track("app_launched", { signed_in: true });
    expect(sink.captured).toHaveLength(1);
    expect(sink.captured[0].event).toBe("app_launched");
    expect(sink.captured[0].properties).toMatchObject({
      app_version: "1.2.3",
      packaged: true,
      signed_in: true,
    });
  });

  it("sends nothing when the owner has opted out", () => {
    const { telemetry, sink } = makeTelemetry({ enabled: false });
    telemetry.track("app_launched");
    telemetry.trackError("uncaught_exception", new Error("boom"));
    expect(sink.captured).toHaveLength(0);
    expect(sink.sent).toHaveLength(0);
  });

  it("is a no-op with no sink (no key baked)", () => {
    const { telemetry } = makeTelemetry({ sink: null });
    telemetry.track("app_launched");
    telemetry.trackError("uncaught_exception", new Error("boom"));
    // Nothing to assert on a null sink beyond not throwing.
  });
});

describe("distinct id", () => {
  it("uses the signed-in account uid, matching the Plow API server's keying", () => {
    const { telemetry, sink } = makeTelemetry({ accountUid: "acct_123" });
    telemetry.track("app_launched");
    expect(sink.captured[0].distinctId).toBe("acct_123");
  });

  it("mints one anonymous install id and keeps it across instances", () => {
    const home = tempHome();
    const first = makeTelemetry({ home });
    first.telemetry.track("app_launched");
    const second = makeTelemetry({ home });
    second.telemetry.track("app_launched");
    const a = first.sink.captured[0].distinctId;
    const b = second.sink.captured[0].distinctId;
    expect(a).toMatch(/[0-9a-f-]{36}/);
    expect(b).toBe(a);
    expect(JSON.parse(fs.readFileSync(path.join(home, "app/telemetry.json"), "utf8"))).toEqual({
      installId: a,
    });
  });
});

describe("the audit allowlist", () => {
  it("reduces intent_received to a verb label — never the path, argv, or goal", () => {
    const { telemetry, sink } = makeTelemetry();
    telemetry.auditEntryRecorded({
      event: "intent_received",
      fields: {
        request: "read file: /Users/owner/Documents/taxes-2025.pdf",
        intentId: "int_1",
        agent: "agent_1",
        agent_name: "My Agent",
        goal: "read ~/Documents/taxes.pdf and email it",
        capabilities: ["fs.read /Users/owner/Documents/taxes-2025.pdf"],
      },
    });
    expect(sink.captured).toHaveLength(1);
    expect(sink.captured[0].event).toBe("audit_intent_received");
    // The label and the opaque agent id — no request prose, goal text,
    // display names, or capabilities.
    expect(sink.captured[0].properties).toEqual({
      app_version: "1.2.3",
      packaged: true,
      agent: "agent_1",
      request_kind: "read file",
    });
    expect(JSON.stringify(sink.captured)).not.toContain("taxes");
    expect(JSON.stringify(sink.captured)).not.toContain("My Agent");
  });

  it("counts a credential fill without its item, origin, or title", () => {
    const { telemetry, sink } = makeTelemetry();
    telemetry.auditEntryRecorded({
      event: "credential_filled",
      fields: { item: "item_9", origin: "https://bank.example.com", title: "My Bank" },
    });
    expect(sink.captured).toHaveLength(1);
    expect(sink.captured[0].event).toBe("audit_credential_filled");
    expect(sink.captured[0].properties).toEqual({ app_version: "1.2.3", packaged: true });
  });

  it("labels every request shape tools.ts writes, and unknown ones as other", () => {
    const { telemetry, sink } = makeTelemetry();
    const requests = [
      "run: grep secret /Users/owner/diary.txt",
      "browse: bank.example.com",
      "browse (visible window): bank.example.com",
      "widen browser session — add origin bank.example.com",
      "some future tool: sensitive detail",
    ];
    for (const request of requests) {
      telemetry.auditEntryRecorded({ event: "intent_received", fields: { request } });
    }
    expect(sink.captured.map((c) => c.properties.request_kind)).toEqual([
      "run",
      "browse",
      "browse (visible window)",
      "widen browser session",
      "other",
    ]);
    const wire = JSON.stringify(sink.captured);
    expect(wire).not.toContain("diary");
    expect(wire).not.toContain("bank.example.com");
    expect(wire).not.toContain("sensitive detail");
  });

  it("reports a host-gate block by cause, confidence and permission — never its path or evidence", () => {
    const { telemetry, sink } = makeTelemetry();
    telemetry.auditEntryRecorded({
      event: "host_permission_blocked",
      fields: {
        intentId: "int_1",
        path: "/Users/owner/Library/Messages/chat.db",
        cause: "macos_permission",
        confidence: "confirmed",
        permission: "full_disk_access",
        evidence: ["the kernel answered EPERM for ~/Library/Messages/chat.db"],
        ruled_out: ["sandbox bound"],
        owner_action: "In System Settings > Privacy & Security > Full Disk Access, turn on Plow Latch.",
        probes: { path: "~/Library/Messages/chat.db", errno: "EPERM" },
      },
    });
    expect(sink.captured).toHaveLength(1);
    expect(sink.captured[0].event).toBe("audit_host_permission_blocked");
    expect(sink.captured[0].properties).toEqual({
      app_version: "1.2.3",
      packaged: true,
      cause: "macos_permission",
      confidence: "confirmed",
      permission: "full_disk_access",
    });
    expect(JSON.stringify(sink.captured)).not.toContain("chat.db");
  });

  it("drops events not in the allowlist — absence fails closed", () => {
    const { telemetry, sink } = makeTelemetry();
    telemetry.auditEntryRecorded({
      event: "some_future_event",
      fields: { anything: "at all" },
    });
    expect(sink.captured).toHaveLength(0);
  });

  it("never forwards non-scalar field values", () => {
    const { telemetry, sink } = makeTelemetry();
    telemetry.auditEntryRecorded({
      event: "exec_end",
      fields: { exit_code: 0, argv: ["/bin/rm", "-rf"] as unknown as string },
    });
    expect(sink.captured[0].properties).toEqual({
      app_version: "1.2.3",
      packaged: true,
      exit_code: 0,
    });
  });

  it("taps a real AuditLog's recorded events end to end", () => {
    const home = tempHome();
    const audit = new AuditLog(path.join(home, "device/audit.ndjson"));
    const { telemetry, sink } = makeTelemetry({ home });
    audit.events.on("recorded", (entry) => telemetry.auditEntryRecorded(entry));
    audit.record("intent_decision", { intentId: "int_1", decision: "allow-once", source: "human" });
    audit.record("not_allowlisted", { secret: "stuff" });
    expect(sink.captured).toHaveLength(1);
    expect(sink.captured[0].event).toBe("audit_intent_decision");
    expect(sink.captured[0].properties).toMatchObject({ decision: "allow-once", source: "human" });
    // The log itself is untouched by the tap — still two events, all fields.
    expect(audit.entries()).toHaveLength(2);
  });
});

describe("error reporting", () => {
  it("builds the $exception payload itself — name and frames, never the message", () => {
    const { telemetry, sink } = makeTelemetry({
      secrets: ["plow_sk_SUPERSECRET"],
      ownerHome: "/Users/owner",
    });
    // A message can embed anything the throwing code interpolated — a vault
    // item's site here — and none of it may leave.
    const error = new Error("could not read a site from \"my-bank.example.com\"");
    error.name = "TypeError";
    error.stack =
      `TypeError: could not read a site from "my-bank.example.com"\n` +
      `    at readSite (/Users/owner/app/vaultItems.js:426:11)\n` +
      `    at fill (/Users/owner/app/broker.js:99:5)`;
    telemetry.trackError("uncaught_exception", error);
    expect(sink.exceptions()).toHaveLength(1);
    const sent = sink.exceptions()[0];
    const list = sent.properties.$exception_list as {
      type: string;
      value: string;
      stacktrace: { type: string; frames: Record<string, unknown>[] };
    }[];
    expect(list[0].type).toBe("TypeError");
    expect(list[0].value).toBe("TypeError");
    expect(list[0].stacktrace.frames[0]).toMatchObject({
      function: "readSite",
      filename: "~/app/vaultItems.js",
      lineno: 426,
      colno: 11,
    });
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain("my-bank.example.com");
    expect(wire).not.toContain("could not read");
    expect(wire).not.toContain("/Users/owner");
    expect(sent.properties).toMatchObject({ scope: "uncaught_exception" });
  });

  it("ships no source context, and nothing downstream can add it", () => {
    // The SDK's captureException reads local files named in frames and
    // attaches surrounding source lines AFTER any sanitising — which is why
    // the sink has no captureException and the payload is built here.
    const { telemetry, sink } = makeTelemetry();
    const error = new Error("boom");
    error.stack = `Error: boom\n    at parse (/etc/hosts:1:1)`;
    telemetry.trackError("uncaught_exception", error);
    const wire = JSON.stringify(sink.exceptions()[0]);
    expect(wire).not.toContain("context_line");
    expect(wire).not.toContain("pre_context");
    expect(wire).not.toContain("post_context");
  });

  it("reduces a custom error name to Error — the name field is writable text", () => {
    const { telemetry, sink } = makeTelemetry();
    const error = new Error("boom");
    error.name = "SECRET_CUSTOM_ERROR_NAME plow_sk_leaked";
    telemetry.trackError("uncaught_exception", error);
    const wire = JSON.stringify(sink.exceptions()[0]);
    expect(wire).not.toContain("SECRET_CUSTOM_ERROR_NAME");
    const list = sink.exceptions()[0].properties.$exception_list as { type: string }[];
    expect(list[0].type).toBe("Error");
  });

  it("does not mistake a multiline message for stack frames", () => {
    const { telemetry, sink } = makeTelemetry();
    // The message region of the stack contains an `at` line of its own; it
    // must be cut with the message, not parsed as a frame.
    const error = new Error("ordinary message\n    at AGENT_TYPED_SECRET");
    telemetry.trackError("uncaught_exception", error);
    const wire = JSON.stringify(sink.exceptions()[0]);
    expect(wire).not.toContain("AGENT_TYPED_SECRET");
    expect(wire).not.toContain("ordinary message");
  });

  it("drops a line that is not a full file:line:col frame", () => {
    const { telemetry, sink } = makeTelemetry();
    const error = new Error("boom");
    error.stack =
      `Error: boom\n` +
      `    at freeform text with no location\n` +
      `    at real (/app/main.js:7:3)`;
    telemetry.trackError("uncaught_exception", error);
    const wire = JSON.stringify(sink.exceptions()[0]);
    expect(wire).not.toContain("freeform");
    expect(wire).toContain("/app/main.js");
  });

  it("scrubs a secret that leaked into a frame line", () => {
    const { telemetry, sink } = makeTelemetry({ secrets: ["plow_sk_SUPERSECRET"] });
    const error = new Error("boom");
    error.stack = `Error: boom\n    at dial (/tmp/plow_sk_SUPERSECRET/main.js:1:1)`;
    telemetry.trackError("uncaught_exception", error);
    const wire = JSON.stringify(sink.exceptions()[0]);
    expect(wire).not.toContain("plow_sk_SUPERSECRET");
    expect(wire).toContain("[redacted]");
  });

  it("reports a non-Error rejection reason without carrying its text", () => {
    const { telemetry, sink } = makeTelemetry();
    telemetry.trackError("unhandled_rejection", "token is plow_sk_whatever");
    expect(sink.exceptions()).toHaveLength(1);
    expect(JSON.stringify(sink.exceptions()[0])).not.toContain("plow_sk_whatever");
  });

  it("uses the ordered send, never the batched capture queue", () => {
    const { telemetry, sink } = makeTelemetry();
    telemetry.trackError("uncaught_exception", new Error("boom"));
    expect(sink.sent).toHaveLength(1);
    expect(sink.captured).toHaveLength(0);
  });

  it("survives a send that rejects", () => {
    const sink = new FakeSink();
    sink.sendNow = async () => {
      throw new Error("offline");
    };
    const { telemetry } = makeTelemetry({ sink });
    expect(() => telemetry.trackError("uncaught_exception", new Error("boom"))).not.toThrow();
  });

  it("caps a runaway stack at 30 frames", () => {
    const { telemetry, sink } = makeTelemetry();
    const error = new Error("deep");
    error.stack = "Error: deep\n" + Array.from({ length: 100 }, (_, i) => `    at f${i} (x.js:1:1)`).join("\n");
    telemetry.trackError("uncaught_exception", error);
    const list = sink.exceptions()[0].properties.$exception_list as {
      stacktrace: { frames: unknown[] };
    }[];
    expect(list[0].stacktrace.frames).toHaveLength(30);
  });
});

describe("the crash spool", () => {
  const spoolPath = (home: string) => path.join(home, "app/crash-report.json");

  it("spools a fatal error to disk before the async send, and deletes it once the send lands", async () => {
    const { telemetry, sink, home } = makeTelemetry();
    let releaseSend = () => {};
    sink.sendNow = () => new Promise((r) => { releaseSend = r; });
    telemetry.trackError("uncaught_exception", new Error("boom"));
    // The spool is on disk synchronously — this is what survives a process
    // that dies before the network write.
    expect(fs.existsSync(spoolPath(home))).toBe(true);
    releaseSend();
    await new Promise((r) => setTimeout(r, 0));
    expect(fs.existsSync(spoolPath(home))).toBe(false);
  });

  it("keeps the spool when the send fails, and the next launch reports it", async () => {
    const home = tempHome();
    const first = makeTelemetry({ home });
    first.sink.sendNow = async () => {
      throw new Error("process died mid-send");
    };
    const error = new Error("boom");
    error.stack = `Error: boom\n    at dial (/app/main.js:1:1)`;
    first.telemetry.trackError("uncaught_exception", error);
    await new Promise((r) => setTimeout(r, 0));
    expect(fs.existsSync(spoolPath(home))).toBe(true);

    // An OFFLINE second launch reports but cannot deliver — the spool stays
    // for the next try, because a queued capture dies with its process.
    const offline = makeTelemetry({ home });
    offline.sink.sendNow = async (message) => {
      offline.sink.sent.push(message);
      throw new Error("still offline");
    };
    offline.telemetry.reportSpooledCrash();
    expect(offline.sink.exceptions()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(fs.existsSync(spoolPath(home))).toBe(true);

    const second = makeTelemetry({ home });
    second.telemetry.reportSpooledCrash();
    expect(second.sink.exceptions()).toHaveLength(1);
    expect(second.sink.exceptions()[0].properties).toMatchObject({
      spooled: true,
      scope: "uncaught_exception",
    });
    expect(JSON.stringify(second.sink.exceptions()[0])).toContain("dial");
    // Deleted only after the flush resolves — then a third launch has
    // nothing to report.
    await new Promise((r) => setTimeout(r, 0));
    expect(fs.existsSync(spoolPath(home))).toBe(false);
    const third = makeTelemetry({ home });
    third.telemetry.reportSpooledCrash();
    expect(third.sink.captured).toHaveLength(0);
  });

  it("deletes a spool that cannot parse, so it never retries forever", () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, "app"), { recursive: true });
    fs.writeFileSync(spoolPath(home), "not json{{{");
    const { telemetry, sink } = makeTelemetry({ home });
    telemetry.reportSpooledCrash();
    expect(sink.captured).toHaveLength(0);
    expect(fs.existsSync(spoolPath(home))).toBe(false);
  });

  it("does not spool a rejection — the process survives those", () => {
    const { telemetry, home } = makeTelemetry();
    telemetry.trackError("unhandled_rejection", new Error("boom"));
    expect(fs.existsSync(spoolPath(home))).toBe(false);
  });
});

describe("shutdown", () => {
  it("flushes the sink", async () => {
    const { telemetry, sink } = makeTelemetry();
    await telemetry.shutdown();
    expect(sink.shutdowns).toBe(1);
  });

  it("swallows a flush that fails", async () => {
    const sink = new FakeSink();
    sink.shutdown = async () => {
      throw new Error("offline");
    };
    const { telemetry } = makeTelemetry({ sink });
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });
});
