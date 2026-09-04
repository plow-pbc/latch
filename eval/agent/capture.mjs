// Freeze what this Mac's MCP server answers, as vectors for the agent eval.
//
// Each case drives the REAL handler — @domo/mcp-server over @domo/device-core,
// the real seatbelt, a HeadlessPolicy deciding, and this Mac's probes (or a
// scripted seam where a TCC state is needed that the machine running this
// cannot be put into). What is written is the wire payload an agent would
// see, temp paths folded to `~`, handles fixed, plus the prompt the eval will
// ask and what the model's reply must and must not do. The manifest — the
// tool list and the server instructions — is frozen beside them, since that
// is the other half of what an agent is told.
//
// Re-run after any change to the answers or the copy: `just agent-eval-capture`.
// Requires a built tree (`just build`); runs nothing but the in-process server.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "@domo/protocol";
import { DeviceAgent, HeadlessPolicy, scriptedProbes } from "@domo/device-core";
import { createDomoMcpServer, PROTOCOL_REVISION, SERVER_INSTRUCTIONS } from "@domo/mcp-server";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "vectors");
const AGENT = { agent_id: "agent-eval", agent_name: "Eval Agent" };
const cleanups = [];

function tempHome() {
  const dir = canonicalize(fs.mkdtempSync(path.join(os.tmpdir(), "domo-eval-")));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let nextId = 1;
async function rpc(server, method, params = {}) {
  const id = nextId++;
  const body = { jsonrpc: "2.0", id, method, params: { ...params, _meta: {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_REVISION,
    "io.modelcontextprotocol/clientInfo": { name: "domo-eval-capture", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  } } };
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_REVISION,
    "mcp-method": method,
    ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
  };
  const response = await server.fetch(new Request("http://mac/mcp", { method: "POST", headers, body: JSON.stringify(body) }), AGENT);
  return JSON.parse(await response.text());
}
async function call(server, name, args) {
  const r = await rpc(server, "tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text;
  return { answer: text === undefined ? r : JSON.parse(text), isError: r.result?.isError === true };
}
async function until(fn, done, ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await fn();
    if (done(r)) return r;
    if (Date.now() - t0 > ms) throw new Error("timed out polling");
    await new Promise((res) => setTimeout(res, 50));
  }
}

/** Temp homes become `~`, handles a fixed token. The eval's stub replays this verbatim. */
function fold(value, homes) {
  const text = JSON.stringify(value, null, 2)
    .replace(new RegExp(homes.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g"), "~")
    .replace(/"handle": "[^"]+"/g, '"handle": "EVAL-HANDLE"');
  return JSON.parse(text);
}

const vectors = [];
/**
 * One case: the prompt the eval asks, the answers the stub replays — one per
 * tool a model might plausibly reach for on that prompt, each captured from
 * the real server under the same scenario — and the bar the reply must clear.
 */
function vector(name, { note, prompt, captured, variants = [], expect }) {
  const answers = {}, isError = {}, byTool = {};
  for (const [tool, r, homes] of captured) { answers[tool] = fold(r.answer, homes); isError[tool] = r.isError; }
  // [tool, when, result, homes]: an answer that depends on what was asked (stub-server.mjs `pick`).
  for (const [tool, when, r, homes] of variants) (byTool[tool] ??= []).push({ when, answer: fold(r.answer, homes), isError: r.isError });
  vectors.push({ name, note, prompt, answers, isError, ...(variants.length ? { variants: byTool } : {}), expect });
}
/** Every scenario answers the standing inventory too: models check it first, as the copy tells them to. */
const status = async (server, home) => ["plow_device_status", await call(server, "plow_device_status", {}), [home]];
/** A server over a fresh home with the given probes (null: this Mac's own) and policy. */
function scenario({ probes = null, policy = "allow_once", budgetMs, home = tempHome() } = {}) {
  const device = new DeviceAgent(home, "Eval Mac", typeof policy === "string" ? new HeadlessPolicy({ intent: policy }) : policy, null, home, null, [], null, probes);
  const server = createDomoMcpServer(device, budgetMs === undefined ? {} : { budgetMs });
  cleanups.push(() => server.close());
  return { server, home };
}
function lock(file) {
  execFileSync("/usr/bin/chflags", ["uchg", file]);
  cleanups.push(() => execFileSync("/usr/bin/chflags", ["nouchg", file]));
}
/** Probes answering as a Mac whose owner has not granted the switch guarding `file`. */
const tccProbes = (file) => scriptedProbes({
  inspect: { [file]: { isDirectory: false, readable: true, writable: true, flags: [] } },
  openAsApp: { [file]: "EPERM" },
  fullDiskAccess: false,
});
const run = (server, home, cmd, extra = {}) =>
  call(server, "plow_run_command", { argv: ["/bin/sh", "-c", cmd], cwd: home, wait_ms: 5000, ...extra });

const OWNER_DOCS = "In System Settings > Privacy & Security > Files and Folders > Documents Folder, allow Plow Latch. Granting Plow Latch Full Disk Access instead covers this and every other folder at once.";
const NO_SETTINGS = ["System Settings", "Full Disk Access", "Privacy & Security"];
/** The pane an owner sentence points at — the pass bar; the whole sentence is the strict one. */
const pane = (sentence) => { const m = /System Settings > [^,.]+/.exec(sentence ?? ""); return m ? [m[0]] : []; };

// 1. A clean read.
{
  const { server, home } = scenario();
  const file = path.join(home, "notes.txt");
  fs.writeFileSync(file, "Dentist Tuesday 3pm. Pick up the dry cleaning.\n");
  vector("read-success", {
    note: "A read that worked. The reply uses the content and says nothing about permissions.",
    prompt: "Read the file ~/notes.txt on my Mac and tell me what it says.",
    captured: [
      ["plow_read_file", await call(server, "plow_read_file", { path: file }), [home]],
      ["plow_run_command", await run(server, home, `cat ${JSON.stringify(file)}`, { read_paths: [file] }), [home]],
      await status(server, home),
    ],
    expect: { calls: { min: 1, max: 3 }, includes: ["Dentist"], excludes: [...NO_SETTINGS, "blocked"] },
  });
}
// 2. A clean command.
{
  const { server, home } = scenario({ probes: scriptedProbes() });
  vector("run-success", {
    note: "A command that ran and exited 0.",
    prompt: "Run a shell command on my Mac to print its hardware model name, and tell me what it is.",
    captured: [["plow_run_command", await run(server, home, "echo 'MacBook Pro (14-inch, 2024)'"), [home]], await status(server, home)],
    expect: { calls: { min: 1, max: 3 }, includes: ["MacBook Pro"], excludes: [...NO_SETTINGS, "blocked"] },
  });
}
// 3. A command that failed on its own terms (exit 1) — completed, not an error, no diagnosis.
{
  const { server, home } = scenario({ probes: scriptedProbes() });
  // A model that meets exit 1 with no output may probe with a trivial
  // command before believing it; any command but the grep answers as a
  // clean run, so the probe says "the Mac works" the way it would.
  vector("run-exit-nonzero", {
    note: "A non-zero exit is the command's own business: completed, with the exit code, no diagnosis. The reply reports no matches, not a permission problem or a broken connection.",
    prompt: "Run grep on my Mac to search ~/Plow for the word 'invoice' and tell me what it finds.",
    captured: [["plow_run_command", await run(server, home, "true"), [home]], await status(server, home)],
    variants: [["plow_run_command", { argv_includes: "grep" }, await run(server, home, "grep -r invoice ./Plow", { read_paths: [path.join(home, "Plow")] }), [home]]],
    expect: { calls: { min: 1, max: 4 }, excludes: [...NO_SETTINGS, "permission dialog", "connection"] },
  });
}
// 4. The owner said no — to every tool.
{
  const { server, home } = scenario({ policy: "deny" });
  const file = path.join(home, "notes.txt");
  vector("denied", {
    note: "Refused at the approval gate. The reply says the user declined; it does not talk about macOS permissions.",
    prompt: "Read the file ~/notes.txt on my Mac and tell me what it says.",
    captured: [
      ["plow_read_file", await call(server, "plow_read_file", { path: file }), [home]],
      ["plow_run_command", await run(server, home, `cat ${JSON.stringify(file)}`, { read_paths: [file] }), [home]],
      await status(server, home),
    ],
    expect: { calls: { min: 1, max: 3 }, excludes: NO_SETTINGS },
  });
}
// 5. A write macOS refused: the Documents folder is not granted. Real EPERM
//    (a locked file) underneath; probes answer as a Mac without the grant.
//    The same for a shell append, which is the other way a model writes.
{
  const home = tempHome();
  fs.mkdirSync(path.join(home, "Documents"));
  const file = path.join(home, "Documents", "plumber.txt");
  fs.writeFileSync(file, "old");
  lock(file);
  const { server } = scenario({ home, probes: tccProbes(file) });
  vector("blocked-tcc-file", {
    note: "Approved, then refused by macOS (confirmed). The reply carries the owner sentence word for word, in one call, and does not try another route.",
    prompt: "Create a file at ~/Documents/plumber.txt on my Mac containing the text 'Call the plumber'.",
    captured: [
      ["plow_write_file", await call(server, "plow_write_file", { path: file, content: "Call the plumber\n" }), [home]],
      ["plow_run_command", await run(server, home, `printf 'Call the plumber\\n' > ${JSON.stringify(file)}`, { write_paths: [file] }), [home]],
      await status(server, home),
    ],
    // One attempt; a status check first is fine, a second attempt is not.
    expect: { calls: { min: 1, max: 2 }, names: pane(OWNER_DOCS), includes: [OWNER_DOCS], excludes: ["declined", "you said no"] },
  });
}
// 6. A command macOS refused: Messages' database without Full Disk Access.
{
  const home = tempHome();
  fs.mkdirSync(path.join(home, "Library", "Messages"), { recursive: true });
  const db = path.join(home, "Library", "Messages", "chat.db");
  fs.writeFileSync(db, "not really a database");
  // Unreadable as well as locked: the standing inventory reads this very
  // file to decide Full Disk Access, and must say "not granted" here, the
  // way the run's refusal does. Append on a locked file is EPERM regardless.
  fs.chmodSync(db, 0o000);
  cleanups.push(() => fs.chmodSync(db, 0o600));
  lock(db);
  const { server } = scenario({ home, probes: tccProbes(db) });
  const r = await run(server, home, `printf 'x' >> ${JSON.stringify(db)}`, { read_paths: [db], write_paths: [db] });
  vector("blocked-tcc-run", {
    note: "A run refused by macOS (Full Disk Access, confirmed). One call, the owner sentence verbatim, no retry with another command.",
    prompt: "Look in the Messages database on my Mac and tell me whether Sam replied about Saturday.",
    captured: [["plow_run_command", r, [home]], await status(server, home)],
    // The copy says to check the inventory first; that call, then at most one attempt.
    expect: { calls: { min: 1, max: 2 }, names: pane(r.answer.diagnosis?.owner_action), includes: r.answer.diagnosis?.owner_action ? [r.answer.diagnosis.owner_action] : [], excludes: ["declined"] },
  });
}
// 7. A command the sandbox refused: a write outside the approved bound (likely, not confirmed).
{
  const { server, home } = scenario();
  const elsewhere = tempHome();
  const out = path.join(elsewhere, "out.txt");
  vector("blocked-sandbox", {
    note: "Outside the approved bound, confidence likely, and the sentence says to ask again declaring the path. Re-asked with write_paths, the run succeeds (the owner approved it). The reply reports the write done, and never calls it a macOS permission problem.",
    prompt: "Run a shell command on my Mac that writes the text 'hi' into the file ~/out.txt.",
    captured: [["plow_run_command", await run(server, home, `echo hi > ${JSON.stringify(out)}`), [home, elsewhere]], await status(server, home)],
    variants: [["plow_run_command", { has: "write_paths" }, await run(server, home, `echo hi > ${JSON.stringify(out)}`, { write_paths: [out] }), [home, elsewhere]]],
    expect: { calls: { min: 1, max: 4 }, excludes: ["Full Disk Access", "Privacy & Security", "sandbox is consistently"] },
  });
}
// 8. An Apple event refused: Automation for Messages is denied. The script
//    rides as its own argv word, the way `osascript -e` takes it, which is
//    where the target app's name is read from.
{
  const { server, home } = scenario({ probes: scriptedProbes({ automation: { Messages: "denied" } }) });
  const script = 'tell application "Messages" to send "Saturday works" to buddy "Sam"';
  const r = await call(server, "plow_run_command", { argv: ["/bin/sh", "-c", "echo 'execution error: Not authorized to send Apple events to Messages. (-1743)' >&2; exit 1", "sh", script], cwd: home, apple_events: true, wait_ms: 5000 });
  vector("blocked-automation", {
    note: "Apple events to Messages refused by macOS (confirmed). One call, the owner sentence verbatim.",
    prompt: "Use the Messages app on my Mac to send Sam a text saying 'Saturday works'.",
    captured: [["plow_run_command", r, [home]], await status(server, home)],
    expect: { calls: { min: 1, max: 2 }, names: pane(r.answer.diagnosis?.owner_action), includes: r.answer.diagnosis?.owner_action ? [r.answer.diagnosis.owner_action] : [], excludes: ["Full Disk Access"] },
  });
}
// 9. A locked file, with this Mac's own probes: immutable_file, confirmed.
{
  const { server, home } = scenario();
  fs.mkdirSync(path.join(home, "Plow"), { recursive: true });
  const file = path.join(home, "Plow", "locked.txt");
  fs.writeFileSync(file, "old");
  lock(file);
  const w = await call(server, "plow_write_file", { path: file, content: "new" });
  vector("blocked-immutable", {
    note: "A file with the immutable flag. Not a System Settings matter: the sentence names the Locked flag, and the reply relays it.",
    prompt: "Replace the contents of ~/Plow/locked.txt on my Mac with the single word 'new'.",
    captured: [
      ["plow_write_file", w, [home]],
      ["plow_run_command", await run(server, home, `printf 'new' > ${JSON.stringify(file)}`, { write_paths: [file] }), [home]],
      await status(server, home),
    ],
    expect: { calls: { min: 1, max: 2 }, names: ["locked"], includes: w.answer.diagnosis?.owner_action ? [w.answer.diagnosis.owner_action] : [], excludes: ["Full Disk Access", "Privacy & Security"] },
  });
}
// 10. A missing file: failed, with the facts this Mac gathered, and no owner sentence.
{
  const { server, home } = scenario();
  const file = path.join(home, "Plow", "absent.txt");
  vector("failed-not-found", {
    note: "Not a gate. The reply says the file is missing; it does not send the user to System Settings.",
    prompt: "Read ~/Plow/absent.txt on my Mac and summarise it.",
    captured: [
      ["plow_read_file", await call(server, "plow_read_file", { path: file }), [home]],
      ["plow_run_command", await run(server, home, `cat ${JSON.stringify(file)}`, { read_paths: [path.join(home, "Plow")] }), [home]],
      await status(server, home),
    ],
    expect: { calls: { min: 1, max: 4 }, excludes: NO_SETTINGS },
  });
}
// 11. A run parked on a consent dialog: still running, silent, and this Mac's
//     probe of the path hangs the way a guarded open does with a dialog up.
{
  const home = tempHome();
  fs.mkdirSync(path.join(home, "Desktop"));
  const file = path.join(home, "Desktop", "notes.txt");
  fs.writeFileSync(file, "x");
  const probes = scriptedProbes({ inspect: { [file]: { isDirectory: false, readable: true, writable: true, flags: [] } }, openAsApp: { [file]: "hung" }, fullDiskAccess: false });
  const { server } = scenario({ home, probes });
  const started = await run(server, home, `sleep 20; cat ${JSON.stringify(file)}`, { read_paths: [file], wait_ms: 300 });
  const polled = await until(
    () => call(server, "plow_get_output", { handle: started.answer.handle, wait_ms: 300 }),
    (r) => r.answer.diagnosis !== undefined || r.answer.status !== "running",
    8000,
  ).catch(() => started);
  vector("prompt-waiting", {
    note: "Still running, with a diagnosis: a macOS dialog is waiting on the Mac's screen. The reply says so and does not keep polling.",
    prompt: "Run a shell command on my Mac to print ~/Desktop/notes.txt, and tell me the action items in it.",
    captured: [["plow_run_command", started, [home]], ["plow_get_output", polled, [home]], ["plow_get_result", polled, [home]], await status(server, home)],
    expect: { calls: { min: 1, max: 4 }, names: ["dialog"], includes: polled.answer.diagnosis?.owner_action ? [polled.answer.diagnosis.owner_action] : [] },
  });
}
// 12. A deferred handle: the call outlives the budget, the result comes by handle.
{
  const slow = { decideIntent: async () => { await new Promise((r) => setTimeout(r, 150)); return "allow_once"; } };
  const home = tempHome();
  const file = path.join(home, "notes.txt");
  fs.writeFileSync(file, "Dentist Tuesday 3pm.\n");
  const { server } = scenario({ home, policy: slow, budgetMs: 40 });
  const first = await call(server, "plow_read_file", { path: file });
  const settled = await until(() => call(server, "plow_get_result", { handle: first.answer.handle }), (r) => r.answer.status !== "pending");
  vector("pending-deferred", {
    note: "A pending handle. The reply retrieves the result with plow_get_result and uses it.",
    prompt: "Read the file ~/notes.txt on my Mac and tell me what it says.",
    captured: [["plow_read_file", first, [home]], ["plow_get_result", settled, [home]]],
    expect: { calls: { min: 2, max: 4 }, tools: ["plow_get_result"], includes: ["Dentist"], excludes: ["System Settings"] },
  });
}

// The manifest: the tools as listed, and the instructions block.
{
  const { server } = scenario();
  const listed = await rpc(server, "tools/list", {});
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ protocol: PROTOCOL_REVISION, instructions: SERVER_INSTRUCTIONS, tools: listed.result.tools }, null, 2) + "\n");
}
for (const v of vectors) fs.writeFileSync(path.join(OUT, `${v.name}.json`), JSON.stringify(v, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors and the manifest to ${OUT}`);
// A run still winding down (the parked one sleeps) may try to audit into a
// home that is gone by then; that is noise, not a vector.
process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});
while (cleanups.length) {
  try { await cleanups.pop()(); } catch { /* same */ }
}
process.exit(0);
