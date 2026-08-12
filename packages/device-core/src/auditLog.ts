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
    // 0700 on the directory, because the per-file rule does not cover the
    // directory's other occupants: identity.json, approvals and settings.json
    // each remember to chmod themselves, but rules.json and scratch/ do not, and
    // the next file added here would have to remember too. One mode on the
    // container is the version of this protection that cannot be forgotten.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(file), 0o700);
    // 0600, like the identity store and settings.json. This is not belt-and-
    // braces: `tool_error` deliberately records the detail withheld from the
    // calling agent -- absolute store paths, backend endpoints -- so a log other
    // local accounts can read hands over exactly what the wire withholds. Under
    // the default 0022 umask an appendFileSync-created file lands 0644.
    //
    // Done once, here, rather than per event: creating with a mode does nothing
    // to a file that already exists, which is what the chmod is for, and both
    // append and truncate preserve the mode of an existing file.
    fs.appendFileSync(file, "", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
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
