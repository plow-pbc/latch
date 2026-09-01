/**
 * Append-only NDJSON audit log — twin of DomoDeviceCore/AuditLog.swift.
 * One event per line: the human record and the test oracle (DESIGN.md §10).
 * The adversarial reviewer does NOT read it — it is handed `history: []` on
 * purpose (DESIGN.md §4).
 *
 * Bounded by rotation, never by rewriting. Once the file passes
 * `AUDIT_ROTATE_BYTES` it is renamed to its `.1` generation and a fresh one
 * begins; the previous generation is replaced, so at most two are on disk.
 * A rename keeps every line that was written exactly as it was written, which
 * a rewrite that trimmed old lines would not. Readers see both generations
 * as one log, oldest first.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { canonicalJSON, isoNow, JSONValue, parseJSON } from "@domo/protocol";

/**
 * Where the current generation rolls over. Around a hundred thousand events —
 * months of ordinary use — and small enough that the desktop UI, which parses
 * the whole log on every listing, stays quick.
 */
export const AUDIT_ROTATE_BYTES = 10 * 1024 * 1024;

export class AuditLog {
  /** Emits "change" whenever an event is recorded, so UIs refresh live. */
  readonly events = new EventEmitter();

  /** The generation before the current one, or nothing. */
  readonly previous: string;

  constructor(
    public readonly file: string,
    private readonly rotateBytes = AUDIT_ROTATE_BYTES,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.previous = rotatedName(file);
  }

  record(event: string, fields: { [k: string]: JSONValue | undefined } = {}): void {
    const entry: { [k: string]: JSONValue | undefined } = { ...fields };
    entry.event = event;
    entry.ts = isoNow();
    this.rotateIfFull();
    fs.appendFileSync(this.file, canonicalJSON(entry as JSONValue) + "\n");
    this.notify();
  }

  /** The current generation becomes the previous one, once it is full. Whole
   * lines only: the check runs before an append, never mid-line. */
  private rotateIfFull(): void {
    const size = fs.statSync(this.file, { throwIfNoEntry: false })?.size ?? 0;
    if (size < this.rotateBytes) return;
    fs.renameSync(this.file, this.previous);
  }

  /**
   * Tell UIs to refresh. Best-effort by contract: `record()` succeeds when the
   * event is durably appended, and nothing after that may fail it. Callers gate
   * real access on that success — BrowserSessions records a session before it
   * publishes one — so a listener throwing (a destroyed webContents during
   * renderer teardown, say) would refuse access the log already says was
   * granted, and leave the two disagreeing in the opposite direction.
   */
  private notify(): void {
    try {
      this.events.emit("change");
    } catch (error: unknown) {
      console.error("[audit] change listener failed after a recorded event:", error);
    }
  }

  /** Erase the log, both generations. Emits "change" so UIs refresh. */
  clear(): void {
    fs.rmSync(this.previous, { force: true });
    fs.writeFileSync(this.file, "");
    this.notify();
  }

  /** All events, oldest first, across both generations. Used by tests and
   * the audit UI. */
  entries(): JSONValue[] {
    return [...readLines(this.previous), ...readLines(this.file)];
  }
}

/** `audit.ndjson` → `audit.1.ndjson`: the extension stays the type. */
function rotatedName(file: string): string {
  const ext = path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, ext)}.1${ext}`);
}

function readLines(file: string): JSONValue[] {
  let data: string;
  try {
    data = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: JSONValue[] = [];
  for (const line of data.split("\n")) {
    if (line.length === 0) continue;
    try {
      out.push(parseJSON(line));
    } catch {
      /* skip malformed lines, matching Swift */
    }
  }
  return out;
}
