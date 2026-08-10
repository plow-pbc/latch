#!/usr/bin/env node
/**
 * domo-mcp (TypeScript) — stdio↔broker shim so MCP clients (Claude Code) can
 * talk to the broker. Twin of Sources/domo-mcp/main.swift: resolves how to
 * connect, sends the auth line, then pipes both ways.
 *
 * Easy path:  DOMO_CONNECTION='domo1.…' (or ~/.domo/agent.json {"connection":…})
 * Explicit:   DOMO_AGENT_TOKEN + optional DOMO_AGENT_SOCKET / DOMO_BROKER_PIN
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalBytes, DomoPaths, jv, parseConnection, parseJSON } from "@domo/protocol";
import {
  Connection,
  SPKIPinningEvaluator,
  UnixSocketDialer,
  WebSocketDialer,
} from "@domo/transport";

const env = process.env;

function agentFileConnection(): string | null {
  try {
    const obj = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".domo/agent.json"), "utf8"),
    ) as { connection?: string };
    return obj.connection ?? null;
  } catch {
    return null;
  }
}

// Resolve endpoint / token / pin. A connection string wins; individual env
// vars fill anything it doesn't carry.
let endpoint: string;
let token: string | undefined;
let pin: string | undefined;
const cs = env.DOMO_CONNECTION ?? agentFileConnection();
const conn = cs ? parseConnection(cs) : null;
if (conn) {
  endpoint = conn.url;
  token = conn.token;
  pin = conn.pin;
} else {
  endpoint = env.DOMO_AGENT_SOCKET ?? DomoPaths.agentSocket();
  pin = env.DOMO_BROKER_PIN;
}
token = token ?? env.DOMO_AGENT_TOKEN;

if (!token) {
  process.stderr.write(
    "domo-mcp: set DOMO_CONNECTION (from `domo-broker issue-agent`) or DOMO_AGENT_TOKEN.\n",
  );
  process.exit(2);
}

async function dialBroker(): Promise<Connection> {
  if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) {
    const trust = pin ? new SPKIPinningEvaluator([{ sha256Base64: pin }]) : null;
    return new WebSocketDialer(endpoint, trust).connect();
  }
  return new UnixSocketDialer(endpoint).connect();
}

async function main(): Promise<void> {
  const conn = await dialBroker();
  let authOk = false;
  let authResolve: (() => void) | null = null;
  const authed = new Promise<void>((resolve) => {
    authResolve = resolve;
  });

  conn.onLine = (line) => {
    if (!authOk) {
      let type: string | null = null;
      try {
        type = jv(parseJSON(line)).get("type").str;
      } catch {
        /* fall through to error */
      }
      if (type === "domo-auth-ok") {
        authOk = true;
        authResolve?.();
        return;
      }
      process.stderr.write("domo-mcp: broker rejected token\n");
      process.exit(3);
    }
    process.stdout.write(line);
    process.stdout.write("\n");
  };
  conn.onClose = () => process.exit(0);
  conn.startReading();

  conn.sendLine(canonicalBytes({ type: "domo-auth", token: token! }));
  const timeout = setTimeout(() => {
    process.stderr.write("domo-mcp: auth timeout\n");
    process.exit(3);
  }, 10_000);
  await authed;
  clearTimeout(timeout);

  // Pipe stdin lines to the socket until EOF.
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    let idx: number;
    while ((idx = buffer.indexOf(0x0a)) !== -1) {
      const line = buffer.subarray(0, idx);
      buffer = buffer.subarray(idx + 1);
      if (line.length > 0) conn.sendLine(Buffer.from(line));
    }
  });
  process.stdin.on("end", () => conn.close());
}

main().catch((error) => {
  process.stderr.write(`domo-mcp: ${error}\n`);
  process.exit(1);
});
