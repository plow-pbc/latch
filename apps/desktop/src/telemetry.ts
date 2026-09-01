/**
 * Usage statistics + error reporting, via PostHog (the same project family the
 * Plow API server and plow.co already report to — see plow's
 * `api/plow/analytics.py` for the pattern this mirrors).
 *
 * Everything outbound goes through this module, and it fails CLOSED twice
 * over: an audit event not in the allowlist below is never sent, and a
 * property not named in that event's allowlist is never sent. Goal text,
 * paths, argv, agent names and credential material therefore cannot ride
 * along — they are simply never copied. Error reports carry no free-form
 * text at all: the error's name and stack frames leave (code locations),
 * its message never does (see `trackError`).
 *
 * Pure Node on purpose (no Electron imports), like viewModel.ts: the suite
 * exercises it with a fake sink and a throwaway home. main.ts supplies the
 * real posthog-node client, and only in a packaged run — a from-source run
 * reports nothing unless DOMO_POSTHOG_KEY is exported.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JSONValue } from "@domo/protocol";

/**
 * The PostHog project this app reports to. Baked in like the API base URL
 * (`resolveApiBaseUrl`): a project key is not a secret — plow.co and the howto
 * site embed theirs in shipped HTML — and a user-editable field would just be
 * a way to point stats at nothing. Empty means "no project yet": telemetry is
 * disabled entirely until a key is pasted here.
 */
const BAKED_POSTHOG_KEY = "phc_yPVitt9NPUXzbgob8JGJupnuELEY4bHKQoDQJctH5E82";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

export interface TelemetryConfig {
  /** Empty string disables telemetry outright. */
  apiKey: string;
  host: string;
}

/**
 * Which project (if any) this run reports to. A from-source run gets no key —
 * dev churn in the product's stats would drown the signal — unless the
 * developer exports DOMO_POSTHOG_KEY, which also lets a packaged build be
 * pointed at a scratch project.
 */
export function resolveTelemetryConfig(opts: {
  env?: Record<string, string | undefined>;
  packaged: boolean;
}): TelemetryConfig {
  const env = opts.env ?? {};
  const override = (env.DOMO_POSTHOG_KEY ?? "").trim();
  const apiKey = override || (opts.packaged ? BAKED_POSTHOG_KEY : "");
  const host = (env.DOMO_POSTHOG_HOST ?? "").trim() || DEFAULT_POSTHOG_HOST;
  return { apiKey, host };
}

export type TelemetryProps = Record<string, string | number | boolean>;

/**
 * What the real posthog-node client is reduced to, so tests can fake it.
 *
 * Deliberately NOT the SDK's `captureException`: its node entrypoint runs an
 * `addSourceContext` frame modifier unconditionally, reading the local files
 * named in stack frames and attaching the surrounding source lines to the
 * outbound payload — after, and outside, this module's scrubbing. Error
 * events are therefore built here as plain `$exception` captures whose every
 * property this module constructed.
 */
export interface TelemetrySink {
  capture(message: { distinctId: string; event: string; properties: Record<string, unknown> }): void;
  /**
   * Deliver ONE event now, resolving only once it has actually been handed
   * to the network, and rejecting on a known failure. Error reports need
   * this ordering: the SDK's `capture()` enqueues behind an async prepare,
   * so a `flush()` issued right after it can flush an EMPTY queue, resolve,
   * and convince the caller the report is safe when it was never sent.
   * Ordinary events ride `capture`'s batching.
   */
  sendNow(message: { distinctId: string; event: string; properties: Record<string, unknown> }): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * The audit → telemetry allowlist: which audit events become usage events, and
 * which of their fields ride along. This is the ONLY path an audit field takes
 * off the Mac, so absence is the default — an event or field not named here is
 * not sent, including every future one until someone adds it deliberately.
 * Deliberately absent: paths, argv, goal text, agent_name, intent ids.
 */
const AUDIT_ALLOWLIST: Record<string, readonly string[]> = {
  // NOT `request`: it is display prose that embeds paths, argv and origins
  // ("read file: /Users/…", "run: grep …"). Only its verb label leaves, via
  // `requestKind` below. `agent` is the opaque server-minted agent id — it
  // enables per-agent counts; `agent_name` (owner/agent-written text) never
  // leaves.
  intent_received: ["agent"],
  intent_decision: ["decision", "source"],
  intent_rejected: ["reason"],
  denied_operation: [],
  file_read: [],
  file_write: [],
  exec_start: [],
  exec_end: ["exit_code"],
  exec_error: [],
  browser_session_opened: [],
  adversarial_review_started: [],
  // Not `reason` — the reviewer writes it in prose about the operation, which
  // can quote paths or goal text.
  adversarial_review_result: ["verdict", "cause"],
  approval_abandoned: [],
  credential_metadata: ["op"],
  // Vault usage, as bare counts: these events' fields carry item ids, origins
  // and titles, so no field is forwarded — the event name is the statistic.
  credential_filled: [],
  credential_denied: [],
  credential_fill_failed: [],
  credential_mask_failed: [],
  credential_payment_approved: [],
};

/**
 * The fixed verb labels tools.ts puts in front of an intent's `request`
 * prose. Membership is EXACT: a label not in this set reports as "other", so
 * a future tool's request text sends nothing until its label is added here.
 */
const REQUEST_KINDS = new Set([
  "read file",
  "write file",
  "run",
  "browse",
  "browse (visible window)",
  "widen browser session",
]);

/** The verb label alone — everything after the first ":" or "—" (the path,
 * argv or origin list) never leaves the Mac. */
export function requestKind(request: string): string {
  const label = request.split(":")[0].split("—")[0].trim();
  return REQUEST_KINDS.has(label) ? label : "other";
}

/**
 * The error names that may leave as-is. `Error.name` is a mutable string —
 * nothing stops code from interpolating data into it — so membership here is
 * the rule, and everything else reports as "Error".
 */
const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AssertionError",
  "SystemError",
  "AbortError",
  "TimeoutError",
]);

/** One genuine V8 frame: "    at fn (file:line:col)" or "    at file:line:col".
 * Anything that does not match in full is not established as a frame and is
 * never transmitted. */
const FRAME_LINE = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

export interface TelemetryDeps {
  /** DOMO_HOME — the anonymous install id persists under it. */
  home: string;
  /** Null when telemetry is configured off; every call is then a no-op. */
  sink: TelemetrySink | null;
  /** The owner's opt-out, read per event so the toggle needs no relaunch. */
  enabled: () => boolean;
  /** Signed-in account uid, or "" — the distinct id when present, matching
   * how the Plow API server keys its events. */
  accountUid: () => string;
  /** Values that must never leave this Mac (the relay credential). Read per
   * event: it changes on sign-in/out. */
  secrets: () => string[];
  /** The owner's real home directory, redacted from error text. */
  ownerHome: string;
  /** Stamped onto every event (version, packaged, platform…). */
  baseProps: TelemetryProps;
}

export class Telemetry {
  private cachedInstallId = "";

  constructor(private readonly deps: TelemetryDeps) {}

  /** Whether anything can leave the Mac right now: a sink exists and the
   * owner has not opted out. */
  private active(): boolean {
    return this.deps.sink !== null && this.deps.enabled();
  }

  /**
   * Who this event belongs to: the signed-in account (the same distinct id
   * the Plow API server uses, so one person's server + desktop events line
   * up), else a random per-install id persisted beside settings.json.
   */
  distinctId(): string {
    const uid = this.deps.accountUid().trim();
    if (uid) return uid;
    if (this.cachedInstallId) return this.cachedInstallId;
    const file = path.join(this.deps.home, "app/telemetry.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { installId?: unknown };
      if (typeof parsed.installId === "string" && parsed.installId.trim()) {
        this.cachedInstallId = parsed.installId.trim();
        return this.cachedInstallId;
      }
    } catch {
      /* first run, or an unreadable file — mint below */
    }
    this.cachedInstallId = crypto.randomUUID();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ installId: this.cachedInstallId }) + "\n");
    } catch {
      /* a home that cannot persist it gets a per-run id — stats, not identity */
    }
    return this.cachedInstallId;
  }

  /** Send one usage event. Properties are caller-constructed, never pass
   * agent-controlled or path-shaped values here — audit fields go through
   * `auditEntryRecorded` and its allowlist instead. */
  track(event: string, properties: TelemetryProps = {}): void {
    if (!this.active()) return;
    try {
      this.deps.sink!.capture({
        distinctId: this.distinctId(),
        event,
        properties: { ...this.deps.baseProps, ...properties },
      });
    } catch {
      /* stats never take the app down */
    }
  }

  /** The audit-log tap: forward an allowlisted event with its allowlisted
   * fields, drop everything else. */
  auditEntryRecorded(entry: { event: string; fields: { [k: string]: JSONValue | undefined } }): void {
    const allowed = AUDIT_ALLOWLIST[entry.event];
    if (!allowed) return;
    const properties: TelemetryProps = {};
    for (const key of allowed) {
      const value = entry.fields[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        properties[key] = value;
      }
    }
    if (entry.event === "intent_received") {
      properties.request_kind = requestKind(String(entry.fields.request ?? ""));
    }
    this.track(`audit_${entry.event}`, properties);
  }

  /**
   * Report an error — its NAME and STACK FRAMES only, never its message.
   * A message is free-form text that can embed anything the throwing code
   * interpolated (a vault item's site, an otpauth parameter, a path), and no
   * scrubber can enumerate what it doesn't know. Frames are code locations —
   * where it broke, not what it broke on — so they are what may leave, still
   * scrubbed (home path collapsed to `~`, secrets redacted) for the dev case
   * where the checkout lives under the home. The `$exception` payload is
   * built entirely here (see TelemetrySink for why the SDK's own path is
   * off-limits); the original Error object never reaches the sink.
   *
   * A fatal error may take the process down before any async send completes
   * — Node runs the uncaughtExceptionMonitor callback and then exits, so the
   * network write below usually loses the race. The report is therefore
   * SPOOLED to disk synchronously first (the one write that survives a dying
   * process), sent live anyway, and the spool is deleted only once the flush
   * says the send happened. A spool that outlives the process is reported by
   * the next launch (`reportSpooledCrash`).
   */
  trackError(scope: string, error: unknown): void {
    if (!this.active()) return;
    try {
      const original = error instanceof Error ? error : new Error();
      // `name` is a mutable string like any other — code can (and does) put
      // interpolated data in it — so only the built-in names pass; anything
      // else reports as plain "Error". Fail closed, not sanitize.
      const name = SAFE_ERROR_NAMES.has(original.name) ? original.name : "Error";
      const frames = this.scrubbedFrames(original);
      const fatal = scope === "uncaught_exception";
      if (fatal) this.writeSpool({ name, frames, scope, ts: new Date().toISOString() });
      // An ORDERED send, not capture-then-flush: capture enqueues behind an
      // async prepare, and a flush racing it can resolve against an empty
      // queue — reporting the spool safe to delete while the event was never
      // sent. sendNow resolves only once the event was handed to the
      // network. Fire-and-forget: if the process dies mid-send, the spool
      // above is what carries the report.
      this.deps.sink!.sendNow(this.exceptionMessage(name, frames, scope)).then(
        () => {
          if (fatal) this.deleteSpool();
        },
        () => {},
      );
    } catch {
      /* stats never take the app down */
    }
  }

  /**
   * Report the crash a previous run spooled but could not deliver before the
   * process died. Call once at startup; a no-op when there is none.
   *
   * The spool is deleted only when its report is out of reach of losing it
   * again: a file that will not parse is deleted at once (a poison spool
   * would otherwise retry forever), but a parsed report keeps its file until
   * the flush RESOLVES — capture only queues, and an offline launch or a
   * second early crash would silently eat a queued report whose file was
   * already gone. A flush that succeeds but dies before the delete means one
   * duplicate next launch; a duplicate is a nuisance, a lost crash is the
   * feature not working.
   */
  reportSpooledCrash(): void {
    if (!this.active()) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.spoolFile(), "utf8");
    } catch {
      return; /* no spool — the common case */
    }
    try {
      const spooled = JSON.parse(raw) as { name?: unknown; frames?: unknown; scope?: unknown };
      const frames = Array.isArray(spooled.frames)
        ? spooled.frames.filter((f): f is string => typeof f === "string").slice(0, 30)
        : [];
      const message = this.exceptionMessage(
        typeof spooled.name === "string" && SAFE_ERROR_NAMES.has(spooled.name)
          ? spooled.name
          : "Error",
        frames,
        typeof spooled.scope === "string" ? spooled.scope : "uncaught_exception",
        { spooled: true },
      );
      // Same ordered send as the live path, for the same reason: the spool
      // may be the only copy, and only a resolved send proves it isn't.
      this.deps.sink!.sendNow(message).then(
        () => this.deleteSpool(),
        () => {},
      );
    } catch {
      // Unreadable, unparseable, or the capture itself threw: this spool can
      // never be reported, and keeping it would retry the same failure at
      // every launch.
      this.deleteSpool();
    }
  }

  /**
   * The scrubbed, genuine frame lines of a stack — and nothing else.
   *
   * Two traps make this stricter than "lines starting with `at`": the stack
   * BEGINS with the message, and a multiline message puts free-form text on
   * lines of its own (`new Error("x\n    at ANYTHING")` reproduces it), so
   * the message region is cut off by exact prefix first; and any remaining
   * line must match the full V8 frame shape (`file:line:col`) or it is
   * dropped entirely. A stack that does not start with the canonical
   * `name[: message]` header ships no frames at all — fail closed.
   */
  private scrubbedFrames(original: Error): string[] {
    const stack = original.stack ?? "";
    const header = original.message ? `${original.name}: ${original.message}` : original.name;
    if (!header || !stack.startsWith(header)) return [];
    return stack
      .slice(header.length)
      .split("\n")
      .filter((line) => FRAME_LINE.test(line))
      .slice(0, 30)
      .map((line) => this.scrub(line));
  }

  /** One `$exception` event, every property built here. `$exception_list`
   * follows PostHog's error-tracking shape with a raw stacktrace; no frame
   * carries context_line/pre_context/post_context, and nothing downstream
   * adds them because nothing downstream processes this event. Returned
   * rather than captured, because the callers need the ordered `sendNow`. */
  private exceptionMessage(
    name: string,
    frames: string[],
    scope: string,
    extra: TelemetryProps = {},
  ): { distinctId: string; event: string; properties: Record<string, unknown> } {
    // Only lines the full frame shape vouches for — a line that fits nothing
    // is dropped, never shipped verbatim. This runs on spooled lines too, so
    // an old or hand-edited spool gets the same gate.
    const frameObjects = frames.flatMap((line) => {
      const match = FRAME_LINE.exec(line);
      if (!match) return [];
      return [
        {
          platform: "node:javascript",
          function: match[1] ?? "?",
          filename: match[2],
          lineno: Number(match[3]),
          colno: Number(match[4]),
          in_app: true,
        },
      ];
    });
    return {
      distinctId: this.distinctId(),
      event: "$exception",
      properties: {
        ...this.deps.baseProps,
        ...extra,
        scope,
        $exception_level: "error",
        $exception_list: [
          {
            type: name,
            value: name,
            mechanism: { handled: false, type: "generic" },
            stacktrace: { type: "raw", frames: frameObjects },
          },
        ],
      },
    };
  }

  private spoolFile(): string {
    return path.join(this.deps.home, "app/crash-report.json");
  }

  /** Synchronous on purpose: it must complete before the monitor callback
   * returns, because nothing after that is guaranteed to run. */
  private writeSpool(report: { name: string; frames: string[]; scope: string; ts: string }): void {
    try {
      fs.mkdirSync(path.dirname(this.spoolFile()), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.spoolFile(), JSON.stringify(report) + "\n");
    } catch {
      /* a home that cannot spool loses the crash report, nothing else */
    }
  }

  private deleteSpool(): void {
    try {
      fs.unlinkSync(this.spoolFile());
    } catch {
      /* already gone */
    }
  }

  /** Redact what must never leave: secret values, then the home path. */
  scrub(text: string): string {
    let out = text;
    for (const secret of this.deps.secrets()) {
      const value = secret.trim();
      if (value) out = out.split(value).join("[redacted]");
    }
    const home = this.deps.ownerHome.replace(/\/+$/, "");
    if (home) out = out.split(home).join("~");
    return out;
  }

  /** Flush the buffer on the way out. Bounded by the caller's teardown. */
  async shutdown(): Promise<void> {
    try {
      await this.deps.sink?.shutdown();
    } catch {
      /* a flush that fails loses a few events, nothing else */
    }
  }
}
