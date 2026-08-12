/**
 * The one way into LTMM: Domo's gateway to the installed `ltmm` CLI.
 *
 * Two operations, one backend. `recall` reads facts for an agent; `startSeeding`
 * builds the store they come from. They live together because they are the same
 * integration -- one decision about which binary runs and in what environment --
 * and because splitting them is what let a test harness override the binary on
 * one path while the other quietly launched the real thing at a real archive.
 * A third operation should extend this seam, not pick between two homes.
 *
 * Everything here runs in the trusted main process, NOT in the seatbelt sandbox.
 * That is the point: the agent gets facts without ever being granted
 * `process.exec` or `network`. Letting an agent run `ltmm` itself through
 * run_command would require exec plus network plus a read capability over a
 * decade of private messages -- the exact combination the adversarial reviewer
 * is instructed to deny.
 *
 * `recall` rather than the blessed tool is the unit, because the ambient path
 * (enriching every tool response with facts relevant to its `goal`) is a second
 * caller of this same function, not a rewrite of it.
 */
import { execFile, spawn } from "node:child_process";

/**
 * The single place that decides which binary runs.
 *
 * `||`, not `??`: an empty override is an unset one. `??` keeps "", and
 * `DOMO_LTMM_BIN=$(which ltmm)` on a Mac with no ltmm sets exactly that --
 * which `spawn` rejects synchronously with ERR_INVALID_ARG_VALUE, before any
 * child exists to report it asynchronously.
 *
 * Read per call rather than captured at import: the drive harnesses set it
 * before importing the app's main process, and a module-level constant would
 * freeze whatever happened to be set when this module first loaded.
 */
function ltmmBin(): string {
  return process.env.DOMO_LTMM_BIN?.trim() || "ltmm";
}

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

/**
 * A fixed cap, not a parameter.
 *
 * There is no size cap on the blessed-tool result path the way there is on file
 * reads, so the payload needs bounding somewhere. Letting the *agent* choose the
 * bound bought nothing — no caller passes one, and the ambient enricher won't
 * either — while costing a validation branch, a schema property and a test
 * matrix, all to let an untrusted caller widen its own read of a private store.
 */
const FACT_LIMIT = 10;

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

/** The only two things a remote caller is ever told about a failed recall. */
export const RECALL_FAILED = "recall failed";
export const RECALL_UNREADABLE = "recall returned an unreadable response";

/**
 * Errors here are split in two on purpose. `message` is a stable, public string
 * safe to hand a caller this repo assumes may be compromised; `cause` carries
 * ltmm's real diagnosis -- absolute store paths, Ollama endpoints and model
 * names -- which is exactly the reconnaissance such a caller wants. `deviceAgent`
 * records the cause in the local audit log and returns only the message.
 *
 * The query rule lives here rather than in the tool because the ambient enricher
 * will be a second caller of this same function; a rule kept in one wrapper is a
 * rule the other caller silently does not have.
 */
export function recall(query: string): Promise<Fact[]> {
  if (query.trim().length === 0) {
    return Promise.reject(new Error("ltmm recall needs a non-empty query"));
  }

  const bin = ltmmBin();
  // `--` terminates option parsing, so a query that opens with a dash stays a
  // query. Without it an agent deliberately denied `process.exec` could still
  // steer this trusted subprocess's flags: `ltmm query` inherits `--store` and
  // `--db`, so a query of `--store=/elsewhere` repoints the whole call. execFile
  // stops *shell* injection; only `--` stops *argument* injection.
  const args = ["query", "--json", "--limit", String(FACT_LIMIT), "--", query];

  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: RECALL_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        // A timeout kills the child by signal and leaves stderr empty, so name
        // the bound that was hit rather than reporting a bare "Command failed".
        if (error.killed) {
          reject(new Error(`ltmm recall exceeded ${RECALL_TIMEOUT_MS}ms`));
          return;
        }
        // The diagnosis stays local, as the cause -- see the note above.
        reject(new Error(RECALL_FAILED, { cause: stderr.trim() || error.message }));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // A Python traceback on stdout carries absolute paths too, so it is a
        // cause for the same reason stderr is.
        reject(new Error(RECALL_UNREADABLE, { cause: stdout.slice(0, 200) }));
        return;
      }
      // Probes `statement`, the field every consumer reads, rather than mere
      // object-ness: `["hello"]`, `[[]]`, `[{}]` and `[null]` all pass an
      // object-ness check and then surface as `undefined` far from this seam.
      // It is a probe, not a schema -- a row carrying `statement` and nothing
      // else still gets through. Optional chaining because `null.statement`
      // throws.
      if (
        !Array.isArray(parsed) ||
        parsed.some((row) => typeof (row as Fact | null | undefined)?.statement !== "string")
      ) {
        reject(new Error(RECALL_UNREADABLE, { cause: "expected an array of fact objects" }));
        return;
      }
      resolve(parsed as Fact[]);
    });
  });
}

/**
 * Build the fact store, so recall has something to answer from without the user
 * configuring anything.
 *
 * `ltmm run` with no arguments resolves the owner's #1 contact itself and builds
 * from that conversation, so Domo never needs to know or hardcode a conversation
 * id. The build is a multi-hour batch over years of messages, so it is spawned
 * detached and never awaited.
 *
 * Unconditional by design. Domo does not track whether a build is running,
 * finished, or died. Every attempt to answer "have we already seeded?" from this
 * side needed a record of a *previous* run, and any such record is either stale
 * (a build that died, or a store that has since fallen behind new messages,
 * skipped forever) or a lie (a pid is a slot the OS reuses). Asking ltmm has
 * neither failure mode, and a store that has fallen behind catches up on the
 * next launch.
 *
 * That correctness is borrowed, not local, so state the contract plainly. Three
 * behaviors of the installed `ltmm` carry it:
 *
 *  1. `run` resumes from its `progress` table rather than rebuilding.
 *  2. `run` exits 0 with "nothing to do" when every day is processed.
 *  3. Concurrent `run`s do not decay a day twice: each claims the writer lock
 *     with `BEGIN IMMEDIATE` and rechecks `progress` under it, so the loser
 *     skips the day rather than reprocessing it.
 *
 * All three hold as of the sibling ltmm change that also adds `query --json`,
 * which is why this repo must not ship ahead of it -- (3) is what makes an
 * unconditional launch safe when the user relaunches Domo mid-build. Nothing on
 * this side can verify any of it: `DOMO_LTMM_BIN` points at whatever the user
 * has, and there is no version floor.
 */
export interface SeedDeps {
  startBuild(bin: string, args: string[]): void;
}

export const liveSeedDeps: SeedDeps = {
  startBuild: (bin, args) => {
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    // Required, not optional: spawn delivers a missing binary as an async
    // `error` event, and an EventEmitter with no `error` listener re-throws it
    // as an uncaught exception -- which in the Electron main process takes the
    // whole app down on any Mac that has no ltmm installed.
    child.on("error", (e) => console.log(`[seed] ltmm unavailable: ${e.message}`));
    // The only record that a build was started, now that nothing is written
    // down: `stdio: "ignore"` throws away ltmm's own output, so without this
    // line "how many times, and when, did Domo spawn a build?" is unanswerable.
    // Gated on the pid because a failed spawn returns a ChildProcess whose pid
    // is already undefined, and an ungated line would claim a start on every
    // launch of a Mac with no ltmm.
    if (child.pid !== undefined) console.log(`[seed] started ${bin} run (pid ${child.pid})`);
    // Let the build outlive this process: it takes hours, and quitting the app
    // would otherwise throw away everything built so far.
    child.unref();
  },
};

export function startSeeding(deps: SeedDeps = liveSeedDeps): void {
  deps.startBuild(ltmmBin(), ["run"]);
}
