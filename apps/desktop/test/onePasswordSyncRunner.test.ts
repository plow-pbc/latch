/**
 * The token for the 1Password sync lives in the owner's env file and reaches
 * `op` through its environment only. A file others could read is refused, and
 * no error quotes the token or what `op` printed.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findOp, opRunner, tokenFromEnvFile } from "../src/onePasswordSyncRunner.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempFile(name: string, body: string, mode: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-runner-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
  return file;
}

describe("tokenFromEnvFile", () => {
  it("reads the token from the shell form the agents' env file uses", () => {
    expect(tokenFromEnvFile(tempFile("a.env", "export OP_SERVICE_ACCOUNT_TOKEN=ops_abc\n", 0o600))).toBe("ops_abc");
    expect(tokenFromEnvFile(tempFile("b.env", "# x\nOP_SERVICE_ACCOUNT_TOKEN=\"ops_q\"\n", 0o600))).toBe("ops_q");
  });

  it("refuses a file others can read, and never says what is in it", () => {
    const file = tempFile("c.env", "export OP_SERVICE_ACCOUNT_TOKEN=ops_leak\n", 0o644);
    expect(() => tokenFromEnvFile(file)).toThrow("the 1Password token file is readable by others; refusing to use it");
  });

  it("missing file or missing variable are plain sentences", () => {
    expect(() => tokenFromEnvFile("/nonexistent/op.env")).toThrow("the 1Password token file is missing");
    expect(() => tokenFromEnvFile(tempFile("d.env", "OTHER=1\n", 0o600))).toThrow("holds no OP_SERVICE_ACCOUNT_TOKEN");
  });
});

describe("opRunner", () => {
  it("passes the token in the environment, not argv, and a failure quotes nothing op printed", async () => {
    const script = tempFile(
      "op",
      '#!/bin/sh\n[ "$1" = boom ] && { echo "ops_tok leaked to stderr" >&2; exit 1; }\nprintf "%s|%s" "$OP_SERVICE_ACCOUNT_TOKEN" "$*"\n',
      0o700,
    );
    const run = opRunner(script, "ops_tok");
    expect(await run(["item", "list"])).toBe("ops_tok|item list");
    await expect(run(["boom", "now"])).rejects.toThrow(/^op boom now failed$/);
  });

  it("finds op only where it is installed", () => {
    expect(findOp(["/nonexistent/op"])).toBeNull();
    const op = tempFile("op", "#!/bin/sh\n", 0o700);
    expect(findOp(["/nonexistent/op", op])).toBe(op);
  });
});
