/**
 * The transport seam — twin of DomoTransport/Transport.swift. Everything above
 * LineRPC speaks Connection, never a concrete socket, so transports swap
 * without touching business logic.
 *
 * Contract carried over from Swift: a listener's onConnection handler
 * CONFIGURES the connection (sets onLine etc.); the listener starts the read
 * loop afterward, so handlers must NOT call startReading themselves. Inbound
 * data is buffered until startReading() so no line is ever dropped.
 */

export interface Connection {
  onLine: ((line: Buffer) => void) | null;
  onClose: (() => void) | null;
  /** Begin delivering inbound lines via onLine. Called once by the owner. */
  startReading(): void;
  /** Send one framed message (framing added by the transport). */
  sendLine(data: Buffer): void;
  close(): void;
}

export interface ConnectionListener {
  onConnection: ((conn: Connection) => void) | null;
  start(): Promise<void>;
  stop(): void;
}

export interface ConnectionDialer {
  connect(): Promise<Connection>;
}

export class RPCError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RPCError";
  }
}
