/**
 * The end-to-end transcripts, run as tests.
 *
 * These scripts are what we actually rely on — they are what caught the binary
 * framing bug that 212 green unit tests did not. But they were `just` recipes
 * only, so nothing ran them unless a person did, and a unit test deleted as
 * "duplicated by the transcript" would have been coverage moved OUT of CI
 * rather than sideways.
 *
 * So the scripts stay the source of truth and this file just runs them and
 * insists they exit 0. Each one already fails loudly on its own checks; all
 * this adds is that CI notices.
 *
 * The Electron-hosted ones (`verify-preload`, `approval-screenshot`,
 * `onboarding-screenshots`) are NOT here: they need a windowing environment, so
 * they run as a separate macOS-only workflow step. Adding them here would make
 * `vitest` on Linux fail for a reason that has nothing to do with the code.
 */
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function transcript(script: string): Promise<string> {
  const { stdout, stderr } = await run(
    "npx",
    ["vite-node", path.join("apps/desktop/scripts", script)],
    { cwd: repoRoot, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout + stderr;
}

describe("end-to-end transcripts", () => {
  it(
    "first-run setup, from a clean home over a real relay handshake",
    async () => {
      const output = await transcript("first-run-transcript.mjs");
      expect(output).toContain("every check passed");
      // The four failure modes with no user-visible feedback are the reason
      // this script exists; a run that stopped exercising them would still say
      // "every check passed". So name them here.
      expect(output).toContain("did not match the activation prefix");
      expect(output).toContain("completion is terminal and outlives our five-minute watch");
      expect(output).toContain("a second redeem is verified with NO token key at all");
      expect(output).toContain("a 410 is an honest message offering a new code");
      // Chunk 13's best-effort client-side revoke is gone: the mint retires the
      // session server-side. If that flag ever stops being sent, the login
      // session quietly outlives onboarding again.
      expect(output).toContain("revoke_calling_session=true");
      expect(output).not.toContain("CAVEAT");
    },
    180_000,
  );

  it(
    "a slow approval and a long command, neither blocking past the relay timeout",
    async () => {
      const output = await transcript("slow-approval-transcript.mjs");
      expect(output).toContain("PASS: no call blocked past the relay timeout");
    },
    180_000,
  );
});
