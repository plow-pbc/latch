/**
 * Durable facts about the people this Mac's owner communicates with, from the
 * LTMM fact store.
 *
 * This runs in the trusted main process, NOT in the seatbelt sandbox. That is the
 * point: the agent gets facts without ever being granted `process.exec` or
 * `network`. Letting an agent run `ltmm` itself through run_command would require
 * exec plus network plus a read capability over a decade of private messages --
 * the exact combination the adversarial reviewer is instructed to deny.
 *
 * `recall` rather than the tool is the unit, because the ambient path (enriching
 * every tool response with facts relevant to its `goal`) is a second caller of
 * this same function, not a rewrite of it.
 */
import { execFile } from "node:child_process";

/** One row of `ltmm query --json`. Ids, never message bodies. */
export interface Fact {
  statement: string;
  type: string;
  person: string;
  confidence: number;
  observed: string;
  message_ids: number[];
}

export const DEFAULT_LIMIT = 10;

/**
 * NOT the call budget -- deliberately far above it.
 *
 * `use_tool` is deferrable (tools.ts:334), so a recall that outruns
 * CALL_BUDGET_MS (8s) comes back as a handle and keeps working; `get_result`
 * collects it. Nothing here needs to finish inside the budget.
 *
 * What this bound exists for is a wedged subprocess. It must sit above the worst
 * honest case, which is a cold Ollama model load: measured on the configured host,
 * the first `qwen3.6:27b` generate after an idle period takes **22.9s**, against
 * **0.65s** warm (embeddings: 0.03s warm). Ollama unloads on idle, so the first
 * recall of a session pays that every time. A 15s bound would kill it for no
 * reason and report a failure that is really a cold cache.
 */
export const RECALL_TIMEOUT_MS = 60_000;

export function recall(query: string, limit: number = DEFAULT_LIMIT): Promise<Fact[]> {
  const bin = process.env.DOMO_LTMM_BIN ?? "ltmm";
  const args = ["query", query, "--json", "--limit", String(limit)];

  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: RECALL_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        // stderr carries ltmm's own diagnosis ("no store at ...", an Ollama
        // failure); surface it rather than a bare exit code.
        const detail = stderr.trim() || error.message;
        reject(new Error(`ltmm recall failed: ${detail}`));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error(`ltmm returned invalid JSON: ${stdout.slice(0, 200)}`));
        return;
      }
      if (!Array.isArray(parsed)) {
        reject(new Error("ltmm returned invalid JSON: expected an array"));
        return;
      }
      resolve(parsed as Fact[]);
    });
  });
}
