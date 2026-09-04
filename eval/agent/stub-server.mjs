// A stand-in for this Mac's MCP server, for the agent eval: it serves the
// frozen manifest (the same tools, the same instructions) and answers every
// tool call with the frozen answer for the case under test. Nothing here
// touches a Mac; the answers are what the real server said when the vectors
// were captured (capture.mjs). What is under test is the pair on the other
// side of the pipe — the MCP client and the model reading the answer.
//
// Classic stdio MCP (JSON-RPC, one message per line): initialize, tools/list,
// tools/call, ping. Env: VECTOR (the case file), CALL_LOG (where each call is
// appended, one JSON line, so the runner can count them independently of the
// transcript).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "vectors", "manifest.json"), "utf8"));
const vector = JSON.parse(fs.readFileSync(process.env.VECTOR, "utf8"));
const callLog = process.env.CALL_LOG ?? null;

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

/**
 * A case may answer one tool differently by what was asked — a run whose
 * argv names grep against any other command, a call that declared
 * write_paths against one that did not — because the real server would, and
 * a model that probes or re-asks must meet what it would meet there. First
 * matching variant wins; the tool's plain answer is the fallback.
 */
function pick(name, args) {
  for (const v of vector.variants?.[name] ?? []) {
    const w = v.when ?? {};
    const argv = Array.isArray(args?.argv) ? args.argv.join(" ") : "";
    if (w.argv_includes !== undefined && !argv.includes(w.argv_includes)) continue;
    if (w.has !== undefined && !(Array.isArray(args?.[w.has]) ? args[w.has].length > 0 : args?.[w.has] !== undefined)) continue;
    return { answer: v.answer, isError: v.isError === true };
  }
  return vector.answers[name] === undefined ? null : { answer: vector.answers[name], isError: vector.isError[name] === true };
}

function answer(name, args) {
  if (callLog) fs.appendFileSync(callLog, JSON.stringify({ name, args, at: new Date().toISOString() }) + "\n");
  const known = pick(name, args);
  if (known === null) {
    // A tool the case did not script: the eval wants to know, so the answer
    // says so plainly rather than inventing one.
    return { content: [{ type: "text", text: JSON.stringify({ error: `the eval scripted no answer for ${name}` }) }], isError: true };
  }
  return { content: [{ type: "text", text: JSON.stringify(known.answer) }], isError: known.isError };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "plow-latch-eval", version: "0" },
      instructions: manifest.instructions,
    });
  } else if (method === "tools/list") {
    reply(id, { tools: manifest.tools });
  } else if (method === "tools/call") {
    reply(id, answer(params?.name, params?.arguments ?? {}));
  } else if (method === "ping") {
    reply(id, {});
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported: ${method}` } });
  }
  // Notifications (no id) get no reply.
});
