/**
 * The transport seam — twin of DomoTransport/Transport.swift. Everything above
 * the transport speaks Connection, never a concrete socket.
 *
 * This Mac only ever DIALS OUT (it holds a WebSocket to the Plow relay), so the
 * listener half of the seam is gone along with the broker that used it.
 * Inbound data is buffered until startReading() so no frame is ever dropped.
 */

export interface Connection {
  onLine: ((line: Buffer) => void) | null;
  onClose: (() => void) | null;
  /** Begin delivering inbound frames via onLine. Called once by the owner. */
  startReading(): void;
  /** Send one framed message (framing added by the transport). */
  sendLine(data: Buffer): void;
  close(): void;
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
