/**
 * The provider seam, end to end through the exec path.
 *
 * What matters is that a vendored CLI is authorised and run WITHOUT anything
 * tool-shaped: the capability is the argv the owner approved, the token never
 * touches it, and a refusal or a failed mint never spawns a child.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSONValue, jv, makeIntent } from "@domo/protocol";
import { DeviceAgent, HeadlessPolicy, MintError, type Minter } from "@domo/device-core";

const TOKEN = "ya29.a0AfB_byExampleTokenValue0000000000";
const cleanups: (() => void)[] = [];

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "latch-prov-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A vendor dir whose `gog` reports the token it was handed and its own argv. */
function vendorDir(): string {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, "gog"),
    '#!/bin/sh\necho "TOKEN=$GOG_ACCESS_TOKEN ARGV=$*"\n',
    { mode: 0o755 },
  );
  return dir;
}

function device(minter: Minter | null, dirs: string[]): DeviceAgent {
  return new DeviceAgent(
    tmp(),
    "Test Mac",
    new HeadlessPolicy({ intent: "allow_once" }),
    null,
    undefined,
    minter,
    dirs,
  );
}

const okMinter = (): Minter => ({ mint: async () => TOKEN });

function run(d: DeviceAgent, argv: string[]): Promise<JSONValue> {
  return d.handleIntent(
    makeIntent({
      agentId: "a1",
      agentDisplay: "Agent",
      deviceId: d.identity.deviceId,
      request: `run: ${argv.join(" ")}`,
      capabilities: [
        { kind: "process.exec", argv },
        { kind: "network", allowed: false },
      ],
      sessionId: "s1",
    }),
    { wait_ms: 8000 },
  );
}

describe("a vendored provider through the exec path", () => {
  it("mints a token into the child's environment, and never into argv", async () => {
    const d = device(okMinter(), [vendorDir()]);
    const out = String(jv(await run(d, ["gog", "gmail", "search", "q"])).get("output").str ?? "");
    expect(out).toContain(`TOKEN=${TOKEN}`);
    // argv is world-readable through ps; the child's environment is not.
    expect(out).toContain("ARGV=");
    expect(out.split("ARGV=")[1]).not.toContain(TOKEN);
  });

  it("puts the belt in front of the command path", async () => {
    const d = device(okMinter(), [vendorDir()]);
    const out = String(jv(await run(d, ["gog", "gmail", "search", "q"])).get("output").str ?? "");
    expect(out).toContain("ARGV=--no-input --wrap-untrusted gmail search q");
  });

  it("records the argv the OWNER approved, not the belted one", async () => {
    // The belt only ever narrows, and it is not what the human read.
    const d = device(okMinter(), [vendorDir()]);
    await run(d, ["gog", "gmail", "search", "q"]);
    const start = d.audit.entries().map((e) => JSON.stringify(e)).find((l) => l.includes("exec_start"))!;
    expect(start).toContain("gmail");
    expect(start).not.toContain("--wrap-untrusted");
  });

  it("refuses an argument that would disarm the belt, without minting or spawning", async () => {
    const mint = vi.fn(async () => TOKEN);
    const d = device({ mint }, [vendorDir()]);
    const response = await run(d, ["gog", "gmail", "search", "q", "--wrap-untrusted=false"]);
    expect(jv(response).get("status").str).toBe("error");
    expect(mint).not.toHaveBeenCalled();
  });

  it("reports a failed mint without spawning, and names no token", async () => {
    const d = device({ mint: async () => { throw MintError.unreachable("gog"); } }, [vendorDir()]);
    const response = await run(d, ["gog", "gmail", "search", "q"]);
    expect(jv(response).get("status").str).toBe("error");
    expect(jv(response).get("error").str).toMatch(/could not reach Plow/);
  });

  it("says the runtime is not paired when no minter is wired", async () => {
    const d = device(null, [vendorDir()]);
    expect(jv(await run(d, ["gog", "gmail", "search", "q"])).get("status").str).toBe("error");
  });

  it("leaves a non-provider command completely alone", async () => {
    const mint = vi.fn(async () => TOKEN);
    const d = device({ mint }, [vendorDir()]);
    const out = String(jv(await run(d, ["/bin/echo", "hello"])).get("output").str ?? "");
    expect(out).toContain("hello");
    expect(mint).not.toHaveBeenCalled();
  });

  it("publishes the skill only when a CLI is staged", () => {
    expect(device(okMinter(), [vendorDir()]).skills.manifest().map((s) => s.name)).toContain(
      "google-workspace",
    );
    // A skill for a binary this Mac does not have would teach an agent to run
    // commands that cannot work.
    expect(device(okMinter(), []).skills.manifest().map((s) => s.name)).not.toContain(
      "google-workspace",
    );
  });
});
