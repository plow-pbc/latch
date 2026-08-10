/**
 * Symmetric JSON-RPC-style messaging over NDJSON — twin of
 * DomoTransport/LineRPC.swift. Both sides can issue requests
 * ({id, method, params}) and receive responses ({id, result|error}).
 */
import { canonicalBytes, JSONValue, jv } from "@domo/protocol";
import { Connection, RPCError } from "./transport.js";

export type RPCHandler = (params: JSONValue) => Promise<JSONValue>;

export class LineRPC {
  private readonly handlers = new Map<string, RPCHandler>();
  private readonly pending = new Map<
    number,
    { resolve: (v: JSONValue) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }
  >();
  private nextId = 1;

  onClose: (() => void) | null = null;

  constructor(private readonly conn: Connection) {
    conn.onLine = (line) => this.handleLine(line);
    conn.onClose = () => this.handleClose();
  }

  start(): void {
    this.conn.startReading();
  }

  register(method: string, handler: RPCHandler): void {
    this.handlers.set(method, handler);
  }

  private handleLine(line: Buffer): void {
    let message: JSONValue;
    try {
      message = JSON.parse(line.toString("utf8")) as JSONValue;
    } catch {
      return;
    }
    const m = jv(message);
    const method = m.get("method").str;
    if (method !== null) {
      const id = m.get("id").int;
      const handler = this.handlers.get(method);
      if (!handler) {
        if (id !== null) {
          this.send({ id, error: { message: `unknown method ${method}` } });
        }
        return;
      }
      // Handlers run async so a slow approval prompt never blocks the connection.
      void handler(m.get("params").value ?? null).then(
        (result) => {
          if (id !== null) this.send({ id, result });
        },
        (error: unknown) => {
          if (id !== null) {
            this.send({ id, error: { message: error instanceof Error ? error.message : String(error) } });
          }
        },
      );
      return;
    }
    const id = m.get("id").int;
    if (id !== null) {
      const completion = this.pending.get(id);
      if (!completion) return;
      this.pending.delete(id);
      if (completion.timer) clearTimeout(completion.timer);
      if (!m.get("error").isNull) {
        completion.reject(new RPCError(m.get("error").get("message").str ?? "remote error"));
      } else {
        completion.resolve(m.get("result").value ?? null);
      }
    }
  }

  private handleClose(): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const completion of waiting) {
      if (completion.timer) clearTimeout(completion.timer);
      completion.reject(new RPCError("connection closed"));
    }
    this.onClose?.();
  }

  private send(message: JSONValue): void {
    this.conn.sendLine(canonicalBytes(message));
  }

  call(method: string, params: JSONValue, timeoutSeconds = 30): Promise<JSONValue> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RPCError(`timeout waiting for ${method}`));
      }, timeoutSeconds * 1000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  close(): void {
    this.conn.close();
  }
}
