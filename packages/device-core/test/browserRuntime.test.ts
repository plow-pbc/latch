/**
 * Runtime resolution against a fake payload: the browser server is now a Node
 * script (@domo/browser-server) run on the host process's own runtime — no
 * bundled Python — and playwright launches a Camoufox binary we point it at. The
 * credential broker still runs in-process (brokerCore.ts) unless the test seam
 * (DOMO_VAULT_BROKER_CMD) names one.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBrowserRuntime } from "@domo/device-core";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.DOMO_BROWSER_CMD;
  delete process.env.DOMO_VAULT_BROKER_CMD;
  delete process.env.DOMO_MERGE_COOKIES_CMD;
  delete process.env.DOMO_CAMOUFOX;
});

/**
 * A packaged Resources dir in the electron-builder layout: only the camoufox
 * tree ships under browser-runtime/ (the server resolves from the app's
 * node_modules — the real @domo/browser-server package, present in this repo).
 * Returns the dir to hand to resolveBrowserRuntime.
 */
function fakePayload(): { resources: string; root: string; binary: string } {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "domo-runtime-"));
  dirs.push(resources);
  const root = path.join(resources, "browser-runtime");
  const app = path.join(
    root,
    "camoufox",
    "browsers",
    "official",
    "152.0.4-beta.28-universal",
    "Camoufox.app",
    "Contents",
    "MacOS",
  );
  fs.mkdirSync(app, { recursive: true });
  const binary = path.join(app, "camoufox");
  fs.writeFileSync(binary, "");
  return { resources, root, binary };
}

describe("resolveBrowserRuntime", () => {
  it("runs the bundled Node server, resolved from @domo/browser-server in node_modules", () => {
    const { resources } = fakePayload();
    const runtime = resolveBrowserRuntime(resources)!;
    expect(runtime).not.toBeNull();
    const [node, server] = runtime.serverCommand;
    expect(node).toBe(process.execPath);
    // The real package's built entry — NOT a copy under the resources dir.
    expect(server).toContain(path.join("browser-server", "dist", "server.js"));
    expect(fs.existsSync(server)).toBe(true);
  });

  it("names the cookie merger beside the server", () => {
    const { resources } = fakePayload();
    const [node, merger] = resolveBrowserRuntime(resources)!.mergeCookiesCommand;
    expect(node).toBe(process.execPath);
    expect(merger).toContain(path.join("browser-server", "dist", "mergeCookies.js"));
    expect(fs.existsSync(merger)).toBe(true);
  });

  it("points playwright at the bundled Camoufox binary", () => {
    const { resources, binary } = fakePayload();
    expect(resolveBrowserRuntime(resources)!.executablePath).toBe(binary);
  });

  it("names no broker subprocess — the credential broker is in-process now", () => {
    const { resources } = fakePayload();
    expect(resolveBrowserRuntime(resources)!.credentialBrokerCommand).toBeNull();
  });

  it("ships no Python: no interpreter, framework, or PYTHONPATH in the resolution", () => {
    const { resources } = fakePayload();
    const runtime = resolveBrowserRuntime(resources)!;
    // The server and merger are Node scripts, not a python interpreter, and the
    // browser is a Camoufox binary, not a Python.framework. (A bare "python"
    // substring check is unusable here — the worktree can be named that.)
    expect(runtime.serverCommand[1].endsWith("server.js")).toBe(true);
    expect(runtime.mergeCookiesCommand[1].endsWith("mergeCookies.js")).toBe(true);
    expect(JSON.stringify(runtime)).not.toContain("Python.framework");
    expect(JSON.stringify(runtime)).not.toContain("site-packages");
    expect(runtime.env.PYTHONPATH).toBeUndefined();
    expect(runtime.env.SSL_CERT_FILE).toBeUndefined();
  });

  it("honors the broker test seam beside a scripted browser", () => {
    process.env.DOMO_BROWSER_CMD = JSON.stringify(["/usr/bin/true"]);
    process.env.DOMO_MERGE_COOKIES_CMD = JSON.stringify(["/usr/bin/true"]);
    process.env.DOMO_VAULT_BROKER_CMD = JSON.stringify(["/fake/broker"]);
    expect(resolveBrowserRuntime()!.credentialBrokerCommand).toEqual(["/fake/broker"]);
  });

  it("leaves the broker in-process even under a scripted browser, unless the seam names one", () => {
    process.env.DOMO_BROWSER_CMD = JSON.stringify(["/usr/bin/true"]);
    process.env.DOMO_MERGE_COOKIES_CMD = JSON.stringify(["/usr/bin/true"]);
    expect(resolveBrowserRuntime()!.credentialBrokerCommand).toBeNull();
  });

  // Under a plain-node host (this test) execPath IS a node, so there must be no
  // stray ELECTRON_RUN_AS_NODE.
  it("adds no ELECTRON_RUN_AS_NODE under a plain-node host", () => {
    const { resources } = fakePayload();
    expect(resolveBrowserRuntime(resources)!.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  // Only the branch is testable here: the app binary must ride with RUN_AS_NODE
  // or it launches the app instead of a node. Whether a packaged, fused,
  // hardened binary honors it is the test machine's smoke to prove.
  it("adds ELECTRON_RUN_AS_NODE under an Electron host, whose execPath is not a node", () => {
    Object.defineProperty(process.versions, "electron", { value: "33.4.11", configurable: true });
    try {
      const runtime = resolveBrowserRuntime(fakePayload().resources)!;
      expect(runtime.env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(runtime.serverCommand[0]).toBe(process.execPath);
    } finally {
      Reflect.deleteProperty(process.versions, "electron");
    }
  });

  it("lets DOMO_CAMOUFOX override the bundled binary", () => {
    const { resources } = fakePayload();
    // A bare path that is not an install tree falls back to itself.
    process.env.DOMO_CAMOUFOX = "/opt/camoufox-bin";
    expect(resolveBrowserRuntime(resources)!.executablePath).toBe("/opt/camoufox-bin");
  });
});
