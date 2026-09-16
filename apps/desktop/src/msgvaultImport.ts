/**
 * The owner-triggered iMessage import, as a pure state machine so it is
 * unit-testable without Electron. Import deliberately bypasses the intent
 * pipeline: the owner clicking the button IS the approval, and no agent can
 * reach it — but the audit log still records every run, because the audit log
 * is the record of what happened on this Mac, not only of what agents did.
 */
import { JSONValue } from "@domo/protocol";

/** Deliberately small while the feature is new; raise when imports are proven. */
export const IMESSAGE_IMPORT_LIMIT = 100;

export interface ImportResult {
  ok: boolean;
  finishedAt: string;
  durationMs: number;
  /** The CLI's last line — "Imported N messages" or the error. */
  summary: string;
}

export type ImportState =
  | { status: "idle"; last: ImportResult | null }
  | { status: "running"; startedAt: string; last: ImportResult | null };

export interface MsgvaultImportJobOptions {
  runImport: () => Promise<{ output: string }>;
  audit?: (event: string, fields: { [k: string]: JSONValue }) => void;
  onChange?: () => void;
  now?: () => Date;
}

/**
 * The line worth showing from the CLI's success output. Its summary block ends
 * with rate/duration noise, so prefer the "N imported" line; otherwise the
 * last non-empty line.
 */
function summarize(output: string): string {
  const lines = output
    .trim()
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines.find((l) => /imported/i.test(l)) ?? lines[lines.length - 1] ?? "";
}

export class MsgvaultImportJob {
  private running: { startedAt: Date } | null = null;
  private last: ImportResult | null = null;

  constructor(private readonly opts: MsgvaultImportJobOptions) {}

  state(): ImportState {
    if (this.running) {
      return {
        status: "running",
        startedAt: this.running.startedAt.toISOString(),
        last: this.last,
      };
    }
    return { status: "idle", last: this.last };
  }

  /** Kick off an import. False when one is already running — never two at once. */
  start(): boolean {
    if (this.running) return false;
    const startedAt = (this.opts.now ?? (() => new Date()))();
    this.running = { startedAt };
    this.opts.audit?.("msgvault_import_started", { limit: IMESSAGE_IMPORT_LIMIT });
    this.opts.onChange?.();
    void this.opts
      .runImport()
      .then(
        (r) => this.finish(startedAt, true, summarize(r.output) || "import finished"),
        (e) => this.finish(startedAt, false, e instanceof Error ? e.message : String(e)),
      );
    return true;
  }

  private finish(startedAt: Date, ok: boolean, summary: string): void {
    const finishedAt = (this.opts.now ?? (() => new Date()))();
    this.last = {
      ok,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      summary,
    };
    this.running = null;
    this.opts.audit?.("msgvault_import_finished", {
      ok,
      summary,
      duration_ms: this.last.durationMs,
    });
    this.opts.onChange?.();
  }
}
