/**
 * Runtime resolution against a fake vendor tree: the browser server must come
 * from the app payload, and the credential broker must NOT be a subprocess any
 * more — it runs in-process (brokerCore.ts), so a resolved runtime names no
 * broker command unless the test seam (DOMO_VAULT_BROKER_CMD) sets one.
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
  delete process.env.PLAYWRIGHT_NODEJS_PATH;
});

/**
 * A packaged Resources dir: python + server under browser-runtime/, the layout
 * electron-builder produces. Returns the dir to hand to resolveBrowserRuntime.
 */
function fakePayload(): { resources: string; root: string } {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "domo-runtime-"));
  dirs.push(resources);
  const root = path.join(resources, "browser-runtime");
  const pyBin = path.join(root, "python", "Python.framework", "Versions", "3.12", "bin");
  fs.mkdirSync(pyBin, { recursive: true });
  fs.writeFileSync(path.join(pyBin, "python3.12"), "");
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.writeFileSync(path.join(root, "server", "server.py"), "");
  const certifi = path.join(root, "python", "site-packages", "certifi");
  fs.mkdirSync(certifi, { recursive: true });
  fs.writeFileSync(path.join(certifi, "cacert.pem"), "");
  return { resources, root };
}

describe("resolveBrowserRuntime", () => {
  it("runs the bundled server on the bundled interpreter, not a PATH install", () => {
    const runtime = resolveBrowserRuntime(fakePayload().resources)!;
    expect(runtime).not.toBeNull();
    const [py, server] = runtime.serverCommand;
    expect(py).toContain(path.join("Python.framework", "Versions", "3.12", "bin", "python3.12"));
    expect(server).toContain("server.py");
  });

  it("names no broker subprocess — the credential broker is in-process now", () => {
    const runtime = resolveBrowserRuntime(fakePayload().resources)!;
    expect(runtime.credentialBrokerCommand).toBeNull();
  });

  it("points the interpreter at the bundled CA bundle, or its https dies in the app", () => {
    const { resources, root } = fakePayload();
    const runtime = resolveBrowserRuntime(resources)!;
    expect(runtime.env.SSL_CERT_FILE).toBe(
      path.join(root, "python", "site-packages", "certifi", "cacert.pem"),
    );
  });

  it("honors the broker test seam beside a scripted browser", () => {
    process.env.DOMO_BROWSER_CMD = JSON.stringify(["/usr/bin/true"]);
    process.env.DOMO_MERGE_COOKIES_CMD = JSON.stringify(["/usr/bin/true"]);
    process.env.DOMO_VAULT_BROKER_CMD = JSON.stringify(["/fake/broker"]);
    const runtime = resolveBrowserRuntime()!;
    expect(runtime.credentialBrokerCommand).toEqual(["/fake/broker"]);
  });

  it("leaves the broker in-process even under a scripted browser, unless the seam names one", () => {
    process.env.DOMO_BROWSER_CMD = JSON.stringify(["/usr/bin/true"]);
    process.env.DOMO_MERGE_COOKIES_CMD = JSON.stringify(["/usr/bin/true"]);
    const runtime = resolveBrowserRuntime()!;
    expect(runtime.credentialBrokerCommand).toBeNull();
  });

  // The runtime ships playwright without its bundled node driver binary; a
  // resolution that doesn't name a substitute leaves the browser unable to
  // launch at all.
  it("points playwright's driver at the host process's own runtime", () => {
    const runtime = resolveBrowserRuntime(fakePayload().resources)!;
    expect(runtime.env.PLAYWRIGHT_NODEJS_PATH).toBe(process.execPath);
    // Under a plain-node host (this test) there must be no stray
    // ELECTRON_RUN_AS_NODE — execPath IS a node.
    expect(runtime.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  // Only the branch is testable here: execPath must ride with RUN_AS_NODE or
  // the app binary launches the app instead of a node. Whether a packaged,
  // fused, hardened binary honors it is the test machine's smoke to prove.
  it("adds ELECTRON_RUN_AS_NODE under an Electron host, whose execPath is not a node", () => {
    Object.defineProperty(process.versions, "electron", { value: "33.4.11", configurable: true });
    try {
      const runtime = resolveBrowserRuntime(fakePayload().resources)!;
      expect(runtime.env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(runtime.env.PLAYWRIGHT_NODEJS_PATH).toBe(process.execPath);
    } finally {
      Reflect.deleteProperty(process.versions, "electron");
    }
  });

  it("lets an explicit PLAYWRIGHT_NODEJS_PATH win over the host runtime", () => {
    process.env.PLAYWRIGHT_NODEJS_PATH = "/usr/local/bin/node";
    const runtime = resolveBrowserRuntime(fakePayload().resources)!;
    expect(runtime.env.PLAYWRIGHT_NODEJS_PATH).toBe("/usr/local/bin/node");
  });
});
