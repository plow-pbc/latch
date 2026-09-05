// The agent eval: does a real MCP client, and the model behind it, read this
// Mac's answers the way the copy intends? Each case hands `claude -p` one
// prompt and one MCP server — the stub replaying that case's frozen answer —
// and checks the transcript: how many tool calls were made, which tools, and
// whether the reply says what it must (the owner sentence, word for word) and
// avoids what it must not (sending the user to System Settings for a file
// that is merely missing).
//
// Not part of `npx vitest run`: it spends model tokens and its answers are
// not deterministic. Run it by hand — `just agent-eval` — with the Claude
// CLI signed in (or ANTHROPIC_API_KEY set). Each case runs several times and
// must pass every time; a flaky pass is a finding, not a pass.
//
//   node eval/agent/run.mjs [--case NAME[,NAME]] [--runs N] [--model M] [--jobs J] [--inject-instructions]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const only = (opt("--case", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const runs = Number(opt("--runs", "3"));
const model = opt("--model", "sonnet");
const jobs = Number(opt("--jobs", "4"));
const timeoutMs = Number(opt("--timeout", "180000"));
// The CLI is expected to hand the server's `instructions` to the model. If a
// client does not, `--inject-instructions` appends them as system prompt so
// the model half can still be judged — and the gap is itself a finding.
const inject = args.includes("--inject-instructions");

const vectorsDir = path.join(here, "vectors");
const outDir = path.join(here, "out", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(vectorsDir, "manifest.json"), "utf8"));
const cases = fs.readdirSync(vectorsDir)
  .filter((f) => f.endsWith(".json") && f !== "manifest.json")
  .map((f) => JSON.parse(fs.readFileSync(path.join(vectorsDir, f), "utf8")))
  .filter((v) => only.length === 0 || only.includes(v.name));
if (cases.length === 0) { console.error(`no case matches ${only.join(",")}`); process.exit(2); }

// Whitespace, curly quotes and markdown emphasis are presentation, not
// rewording: "**System Settings**" still relays the sentence.
const norm = (s) => String(s).replace(/[*_`]/g, "").replace(/\s*(?:→|›|»)\s*/g, " > ").replace(/\s+/g, " ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();

/** One `claude -p` run of one case. Returns what happened and the verdict. */
async function runOnce(v, n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-eval-${v.name}-`));
  const vectorFile = path.join(vectorsDir, `${v.name}.json`);
  const callLog = path.join(dir, "calls.ndjson");
  const mcpConfig = path.join(dir, "mcp.json");
  fs.writeFileSync(mcpConfig, JSON.stringify({
    mcpServers: { plow: { command: process.execPath, args: [path.join(here, "stub-server.mjs")], env: { VECTOR: vectorFile, CALL_LOG: callLog } } },
  }));
  const cliArgs = [
    "-p", v.prompt,
    "--mcp-config", mcpConfig, "--strict-mcp-config",
    "--allowedTools", "mcp__plow",
    "--disallowedTools", "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Agent",
    "--model", model,
    "--output-format", "stream-json", "--verbose",
    ...(inject ? ["--append-system-prompt", manifest.instructions] : []),
  ];
  // Never inherit a Claude Code session's own markers: a nested session would
  // refuse or misroute, and the eval must be the same from a terminal.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CLAUDE(CODE|_CODE)/.test(k)) delete env[k];
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

  const t0 = Date.now();
  const { stdout, stderr, code, timedOut } = await new Promise((resolve) => {
    const child = spawn("claude", cliArgs, { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout: out, stderr: err, code, timedOut }); });
  });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);

  // The transcript: every assistant block, and the final result text.
  const events = stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const toolUses = events.flatMap((e) => e.type === "assistant" ? (e.message?.content ?? []).filter((c) => c.type === "tool_use") : []);
  const finalText = events.filter((e) => e.type === "result").map((e) => e.result ?? "").join("\n")
    || events.flatMap((e) => e.type === "assistant" ? (e.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text) : []).join("\n");
  const logged = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const called = logged.map((c) => c.name);

  const failures = [];
  const x = v.expect;
  if (timedOut) failures.push(`timed out after ${timeoutMs / 1000}s`);
  if (code !== 0 && !timedOut) failures.push(`claude exited ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`);
  if (x.calls && called.length < x.calls.min) failures.push(`${called.length} tool call(s), expected at least ${x.calls.min}`);
  if (x.calls && called.length > x.calls.max) failures.push(`${called.length} tool call(s), expected at most ${x.calls.max}: ${called.join(", ")}`);
  for (const t of x.tools ?? []) if (!called.includes(t)) failures.push(`never called ${t}`);
  // The attempt is what a refusal — and the owner's surfaces — come from;
  // a status check that stands in for it leaves the user with nowhere to click.
  if (x.attempted && !called.some((c) => c !== "plow_device_status")) failures.push("never attempted the operation: only checked status");
  const text = norm(finalText);
  // Two bars. `names` is the pass bar: the reply must point at the right
  // thing (the pane, the flag, the dialog). `includes` is the strict one the
  // copy asks for — the owner sentence word for word — reported beside it,
  // since a model that names the pane but rewords the sentence is a finding
  // about the copy, not a broken tool.
  for (const s of x.names ?? []) if (!text.toLowerCase().includes(norm(s).toLowerCase())) failures.push(`reply never names "${s}"`);
  for (const s of x.excludes ?? []) if (text.toLowerCase().includes(norm(s).toLowerCase())) failures.push(`reply mentions "${s}"`);
  const verbatim = (x.includes ?? []).every((s) => text.includes(norm(s)));
  const notVerbatim = (x.includes ?? []).filter((s) => !text.includes(norm(s))).map((s) => `not word for word: "${s.slice(0, 50)}…"`);

  fs.writeFileSync(path.join(outDir, `${v.name}.${n}.jsonl`), stdout);
  fs.writeFileSync(path.join(outDir, `${v.name}.${n}.txt`), [
    `# ${v.name} run ${n} — ${failures.length ? "FAIL" : "pass"}${verbatim ? "" : ", not verbatim"} (${seconds}s, ${toolUses.length} tool_use, calls: ${called.join(", ") || "none"})`,
    ...failures.map((f) => `- ${f}`), ...notVerbatim.map((f) => `- ${f}`), "", "## prompt", v.prompt, "", "## reply", finalText, "", "## stderr", stderr,
  ].join("\n"));
  fs.rmSync(dir, { recursive: true, force: true });
  return { name: v.name, n, seconds, called, failures, verbatim, notVerbatim };
}

// A small pool: several cases at once, each case's runs in order.
const queue = cases.flatMap((v) => Array.from({ length: runs }, (_, i) => [v, i + 1]));
const results = [];
async function worker() {
  for (;;) {
    const next = queue.shift();
    if (!next) return;
    const r = await runOnce(...next);
    results.push(r);
    console.log(`${r.failures.length ? "FAIL" : "pass"}  ${r.name} #${r.n}  ${r.seconds}s  [${r.called.join(", ") || "no calls"}]${[...r.failures, ...r.notVerbatim].map((f) => `\n      - ${f}`).join("")}`);
  }
}
console.log(`${cases.length} case(s) × ${runs} run(s), model ${model}, ${jobs} at a time → ${path.relative(process.cwd(), outDir)}\n`);
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));

const byCase = new Map();
for (const r of results) byCase.set(r.name, [...(byCase.get(r.name) ?? []), r]);
console.log("\n" + "case".padEnd(22) + "passed   verbatim");
let failed = 0;
for (const v of cases) {
  const rs = byCase.get(v.name) ?? [];
  const ok = rs.filter((r) => r.failures.length === 0).length;
  const word = rs.filter((r) => r.verbatim).length;
  if (ok < rs.length) failed += 1;
  const strict = (v.expect.includes ?? []).length ? `${word}/${rs.length}` : "-";
  console.log(`${v.name.padEnd(22)}${`${ok}/${rs.length}`.padEnd(9)}${strict}${ok < rs.length ? "  ← see " + path.relative(process.cwd(), outDir) : ""}`);
}
console.log(`\n${cases.length - failed}/${cases.length} cases passed every run. "verbatim" is the owner sentence relayed word for word, the strict bar the copy asks for.`);
process.exit(failed ? 1 : 0);
