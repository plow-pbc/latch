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

/**
 * One row of `ltmm query --json`. Ids, never message bodies.
 *
 * A type alias rather than an interface so TypeScript grants it an implicit
 * index signature and it is assignable to `JSONValue` directly -- an interface
 * would force the blessed-tool wrapper into an `as unknown as JSONValue` double
 * cast, which silences exactly the structural mismatch worth knowing about.
 */
export type Fact = {
  statement: string;
  type: string;
  person: string;
  confidence: number;
  observed: string;
  message_ids: number[];
};

export const DEFAULT_LIMIT = 10;

/**
 * `limit` is agent-controlled, and the whole store would otherwise be reachable
 * through one call -- there is no size cap on the blessed-tool result path the
 * way there is on file reads.
 */
export const MAX_LIMIT = 100;

/**
 * NOT the call budget -- deliberately far above it.
 *
 * `use_tool` is deferrable (see `mcp-server/src/tools.ts`), so a recall that
 * outruns CALL_BUDGET_MS (8s) comes back as a handle and keeps working;
 * `get_result` collects it. Nothing here needs to finish inside the budget.
 *
 * What this bound exists for is a wedged subprocess. It must sit above the worst
 * honest case, which is a cold Ollama model load: measured on the configured host,
 * the first `qwen3.6:27b` generate after an idle period takes **22.9s**, against
 * **0.65s** warm (embeddings: 0.03s warm). Ollama unloads on idle, so the first
 * recall of a session pays that every time. A 15s bound would kill it for no
 * reason and report a failure that is really a cold cache.
 */
export const RECALL_TIMEOUT_MS = 60_000;

/**
 * Both arguments are typed but validated anyway: this is the trust boundary, and
 * the blessed tool hands through whatever the agent sent. Coercing `limit`
 * instead would put `--limit NaN` in front of argparse and return its usage
 * error, which reads exactly like a genuine store failure.
 *
 * Both rules live here rather than in the tool because the ambient enricher will
 * be a second caller of this same function; a rule kept in one wrapper is a rule
 * the other caller silently does not have.
 */
export function recall(query: string, limit: number = DEFAULT_LIMIT): Promise<Fact[]> {
  if (query.trim().length === 0) {
    return Promise.reject(new Error("ltmm recall needs a non-empty query"));
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return Promise.reject(
      new Error(`ltmm recall needs an integer limit in 1..${MAX_LIMIT}, got ${limit}`),
    );
  }

  const bin = process.env.DOMO_LTMM_BIN ?? "ltmm";
  // `--` terminates option parsing, so a query that opens with a dash stays a
  // query. Without it an agent deliberately denied `process.exec` could still
  // steer this trusted subprocess's flags: `ltmm query` inherits `--store` and
  // `--db`, so a query of `--store=/elsewhere` repoints the whole call. execFile
  // stops *shell* injection; only `--` stops *argument* injection.
  const args = ["query", "--json", "--limit", String(limit), "--", query];

  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: RECALL_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        // A timeout kills the child by signal and leaves stderr empty, so name
        // the bound that was hit rather than reporting a bare "Command failed".
        if (error.killed) {
          reject(new Error(`ltmm recall exceeded ${RECALL_TIMEOUT_MS}ms`));
          return;
        }
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
      // Probing `statement` rather than object-ness catches every shape that
      // parses but is not a fact -- `["hello"]`, `[[]]`, `[{}]`, `[null]` all
      // reach here otherwise and surface as `undefined` fields at a consumer far
      // from this seam. Optional chaining because `null.statement` throws.
      if (
        !Array.isArray(parsed) ||
        parsed.some((row) => typeof (row as Fact | null | undefined)?.statement !== "string")
      ) {
        reject(new Error("ltmm returned invalid JSON: expected an array of fact objects"));
        return;
      }
      resolve(parsed as Fact[]);
    });
  });
}
