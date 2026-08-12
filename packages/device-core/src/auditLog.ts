/**
 * Append-only NDJSON audit log — twin of DomoDeviceCore/AuditLog.swift.
 * One event per line: the human record, the test oracle (DESIGN.md §10), and
 * the stream the future adversarial reviewer consumes.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { canonicalJSON, isoNow, JSONValue, parseJSON } from "@domo/protocol";

export class AuditLog {
  /** Emits "change" whenever an event is recorded, so UIs refresh live. */
  readonly events = new EventEmitter();

  constructor(public readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  record(event: string, fields: { [k: string]: JSONValue | undefined } = {}): void {
    const entry: { [k: string]: JSONValue | undefined } = { ...fields };
    entry.event = event;
    entry.ts = isoNow();
    fs.appendFileSync(this.file, canonicalJSON(entry as JSONValue) + "\n");
    this.events.emit("change");
  }

  /** Erase the log (truncate the file). Emits "change" so UIs refresh. */
  clear(): void {
    fs.writeFileSync(this.file, "");
    this.events.emit("change");
  }

  /** All events, oldest first. Used by tests and the audit UI. */
  entries(): JSONValue[] {
    let data: string;
    try {
      data = fs.readFileSync(this.file, "utf8");
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
}
