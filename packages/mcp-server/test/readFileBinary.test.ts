/**
 * A binary file must reach the agent as bytes, not as a string. Base64 in a
 * JSON text block is a string a client may shorten: Hermes cuts any MCP text
 * result over 2,000,000 chars and splices a notice into the middle, which
 * corrupted every iPhone photo over ~1.5 MB (latch#368). An MCP embedded
 * resource is stored by the client as a file instead.
 */
import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalize } from "@domo/protocol";
import { DeviceAgent, PolicyDelegate } from "@domo/device-core";
import { createDomoMcpServer, RelayAuth } from "@domo/mcp-server";
import { callTool, parse, pollUntil, rpc } from "./client.js";

const AGENT: RelayAuth = { agent_id: "agent-1", agent_name: "Agent One", scopes: ["relay:call"] };
type Block = { type: string; text?: string; resource?: { uri: string; blob: string } };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-read-binary-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A policy that answers `allow_once` after `delayMs`. */
const allowAfter = (delayMs: number): PolicyDelegate => ({
  decideIntent: () =>
    new Promise((resolve) =>
      setTimeout(() => resolve({ decision: "allow_once" as const, source: "ask" }), delayMs),
    ),
});

function serverWith(delegate: PolicyDelegate, budgetMs: number) {
  const server = createDomoMcpServer(new DeviceAgent(tempDir(), "Test Mac", delegate), { budgetMs });
  cleanups.push(() => server.close());
  // 3 MiB of random bytes: never valid UTF-8, and its base64 (4 MiB) is past
  // the 2,000,000-char point where a text result was being cut.
  const file = path.join(tempDir(), "IMG_7287.heic");
  const bytes = crypto.randomBytes(3 * 1024 * 1024);
  fs.writeFileSync(file, bytes);
  return { server, file, bytes };
}

async function blocks(server: ReturnType<typeof serverWith>["server"], name: string, args: object) {
  return parse(await rpc(server, "tools/call", { name, arguments: args }, AGENT)).result!
    .content as unknown as Block[];
}

describe("plow_read_file on a binary file", () => {
  it("returns the exact bytes as an embedded resource named after the file", async () => {
    const { server, file, bytes } = serverWith(allowAfter(0), 10_000);

    const [resource, summary] = await blocks(server, "plow_read_file", { path: file });

    // The tool canonicalizes the path (macOS tmp is /var → /private/var).
    expect(resource.type).toBe("resource");
    expect(resource.resource!.uri).toBe(pathToFileURL(canonicalize(file)).href);
    expect(Buffer.from(resource.resource!.blob, "base64").equals(bytes)).toBe(true);
    expect(JSON.parse(summary.text!)).toEqual({
      status: "completed",
      path: canonicalize(file),
      bytes: bytes.length,
    });
  });

  it("returns the same resource when the read had to wait for approval", async () => {
    // Decides after the 20ms budget, so the call answers pending first.
    const { server, file, bytes } = serverWith(allowAfter(150), 20);

    const pending = await callTool(server, "plow_read_file", { path: file }, AGENT);
    expect(pending.payload.status).toBe("pending");

    const [resource, summary, envelope] = await pollUntil(
      () => blocks(server, "plow_get_result", { handle: pending.payload.handle }),
      (b) => b[0]?.type === "resource",
    );
    expect(Buffer.from(resource.resource!.blob, "base64").equals(bytes)).toBe(true);
    expect(JSON.parse(summary.text!)).toEqual({
      status: "completed",
      path: canonicalize(file),
      bytes: bytes.length,
    });
    expect(JSON.parse(envelope.text!)).toEqual({ status: "ready", handle: pending.payload.handle });
  });
});
