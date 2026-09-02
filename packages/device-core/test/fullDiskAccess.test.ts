/**
 * The Full Disk Access probe. The real protected paths cannot be exercised in
 * a test (whether they open depends on what the human granted this process's
 * host), so the probe takes its path list as a parameter and these run it
 * against fixtures with the three shapes a probe path can have: readable,
 * missing, and present-but-refused.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fullDiskProbePaths, probeFullDiskAccess } from "../src/hostGate/fullDiskAccess.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-fda-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("probeFullDiskAccess", () => {
  it("reports granted when a probe file opens", async () => {
    const p = path.join(dir, "chat.db");
    fs.writeFileSync(p, "data");
    expect(await probeFullDiskAccess([p])).toBe(true);
  });

  it("skips missing probes and still finds a readable one", async () => {
    const readable = path.join(dir, "TCC.db");
    fs.writeFileSync(readable, "data");
    expect(await probeFullDiskAccess([path.join(dir, "absent.db"), readable])).toBe(true);
  });

  it("reports not granted when every probe is missing", async () => {
    expect(await probeFullDiskAccess([path.join(dir, "absent.db")])).toBe(false);
  });

  // Root opens a 0o000 file anyway, so this case would assert the wrong thing
  // there; the suite runs as a user everywhere that matters.
  it.skipIf(process.getuid?.() === 0)(
    "reports not granted when the probe exists but the open is refused",
    async () => {
      const refused = path.join(dir, "protected.db");
      fs.writeFileSync(refused, "data");
      fs.chmodSync(refused, 0o000);
      expect(await probeFullDiskAccess([refused])).toBe(false);
    },
  );

  it("defaults to TCC-protected files in the real home, Messages among them", () => {
    const paths = fullDiskProbePaths("/Users/probe");
    expect(paths).toContain("/Users/probe/Library/Messages/chat.db");
    for (const p of paths) expect(p.startsWith("/Users/probe/Library/")).toBe(true);
  });
});
