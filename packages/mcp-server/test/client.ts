/**
 * A minimal MCP 2026-07-28 client, in memory.
 *
 * Modern MCP is per-request: there is no initialize handshake and no session.
 * Each request carries the per-request envelope in `params._meta` and must
 * declare its method (and, for a tool call, its name) in headers that agree
 * with the body. That is the whole client — writing it here rather than pulling
 * one in keeps the test exercising the real wire shape a relay will tunnel.
 */
import { DomoMcpServer, PROTOCOL_REVISION, RelayAuth } from "@domo/mcp-server";

const META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_REVISION,
  "io.modelcontextprotocol/clientInfo": { name: "domo-test-client", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

let nextId = 1;

/** POST one JSON-RPC request through the server exactly as the relay would. */
export async function rpc(
  server: DomoMcpServer,
  method: string,
  params: Record<string, unknown> = {},
  auth?: RelayAuth,
  overrides: { headers?: Record<string, string>; protocolVersion?: string } = {},
): Promise<RawResponse> {
  const id = nextId++;
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        ...META,
        "io.modelcontextprotocol/protocolVersion":
          overrides.protocolVersion ?? PROTOCOL_REVISION,
      },
    },
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": overrides.protocolVersion ?? PROTOCOL_REVISION,
    "mcp-method": method,
    ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
    ...overrides.headers,
  };
  const response = await server.fetch(
    new Request("http://mac/mcp", { method: "POST", headers, body: JSON.stringify(body) }),
    auth,
  );
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}

export function parse(raw: RawResponse): {
  result?: { content?: { type: string; text: string }[]; isError?: boolean; tools?: unknown[] };
  error?: { code: number; message: string; data?: unknown };
} {
  return JSON.parse(raw.body);
}

/** Call a tool and return the JSON payload it produced, plus its error flag. */
export async function callTool(
  server: DomoMcpServer,
  name: string,
  args: Record<string, unknown>,
  auth?: RelayAuth,
): Promise<{ payload: any; isError: boolean; status: number }> {
  const raw = await rpc(server, "tools/call", { name, arguments: args }, auth);
  const parsed = parse(raw);
  const text = parsed.result?.content?.[0]?.text;
  if (text === undefined) {
    // No tool result at all — a JSON-RPC-level error (unknown tool, bad
    // envelope). Hand back the whole response so the test can see it.
    return { payload: parsed, isError: parsed.error !== undefined, status: raw.status };
  }
  // The SDK's own argument-validation failure is plain prose, not our JSON.
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: text };
  }
  return { payload, isError: parsed.result?.isError === true, status: raw.status };
}
