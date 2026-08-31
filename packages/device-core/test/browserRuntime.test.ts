/**
 * Runtime resolution against a fake vendor tree: the broker and the vault CLI
 * must both come from the app payload, so a machine with neither installed can
 * still fill a credential.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBrowserRuntime } from "@domo/device-core";

const arch = process.arch === "arm64" ? "arm64" : "x86_64";
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.SEED_VAULT_BW;
  delete process.env.PLAYWRIGHT_NODEJS_PATH;
});

/**
 * A packaged Resources dir: python + server (+ vault CLI) under
 * browser-runtime/, the layout electron-builder produces. Returns the dir to
 * hand to resolveBrowserRuntime.
 */
/** Which vault-server tree to lay down. Only `per-arch` is a layout the build
 * produces; the rest are the shapes a stopped or hand-made build leaves. */
type VaultShape = "per-arch" | "flat" | "binary-only";

const VAULT_TREES: Record<VaultShape, string[]> = {
  "per-arch": [`${arch}/vaultwarden`, "web-vault/.keep"],
  flat: ["vaultwarden", "web-vault/.keep"],
  "binary-only": [`${arch}/vaultwarden`],
};

function fakePayload(opts: { withVaultCli: boolean; vaultServer?: VaultShape }): { resources: string; root: string } {
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
  if (opts.withVaultCli) {
    fs.mkdirSync(path.join(root, "vault-cli", arch), { recursive: true });
    fs.writeFileSync(path.join(root, "vault-cli", arch, "bw"), "");
  }
  for (const rel of opts.vaultServer ? VAULT_TREES[opts.vaultServer] : []) {
    fs.mkdirSync(path.join(root, "vault-server", path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, "vault-server", rel), "");
  }
  return { resources, root };
}

describe("resolveBrowserRuntime", () => {
  it("runs the bundled broker on the bundled interpreter, not a PATH install", () => {
    const runtime = resolveBrowserRuntime(fakePayload({ withVaultCli: true }).resources)!;
    expect(runtime).not.toBeNull();
    const [py, ...rest] = runtime.credentialBrokerCommand;
    expect(py).toContain(path.join("Python.framework", "Versions", "3.12", "bin", "python3.12"));
    expect(rest).toEqual(["-m", "seed_vault_broker"]);
  });

  it("points the broker at the vault CLI shipped for this arch", () => {
    const { resources, root } = fakePayload({ withVaultCli: true });
    const runtime = resolveBrowserRuntime(resources)!;
    expect(runtime.env.SEED_VAULT_BW).toBe(path.join(root, "vault-cli", arch, "bw"));
  });

  it("leaves SEED_VAULT_BW unset when nothing is bundled, so a PATH bw still works", () => {
    const runtime = resolveBrowserRuntime(fakePayload({ withVaultCli: false }).resources)!;
    expect(runtime.env.SEED_VAULT_BW).toBeUndefined();
  });

  it("points the interpreter at the bundled CA bundle, or its https dies in the app", () => {
    const { resources, root } = fakePayload({ withVaultCli: true });
    const runtime = resolveBrowserRuntime(resources)!;
    expect(runtime.env.SSL_CERT_FILE).toBe(
      path.join(root, "python", "site-packages", "certifi", "cacert.pem"),
    );
  });

  it("finds the vault this build ships, binary plus web interface", () => {
    const { resources, root } = fakePayload({ withVaultCli: true, vaultServer: "per-arch" });
    const runtime = resolveBrowserRuntime(resources)!;
    expect(runtime.vaultServer).toEqual({
      binary: path.join(root, "vault-server", arch, "vaultwarden"),
      webVaultDir: path.join(root, "vault-server", "web-vault"),
    });
  });

  // Neither is a layout the build produces, and packaging refuses both — a
  // resolver that took either would accept a tree that cannot ship.
  it.each(["flat", "binary-only"] as const)("reports no vault for a %s tree", (shape) => {
    const { resources } = fakePayload({ withVaultCli: false, vaultServer: shape });
    expect(resolveBrowserRuntime(resources)!.vaultServer).toBeNull();
  });

  it("reports no vault when this build ships none, so we can still point at a hosted one", () => {
    const runtime = resolveBrowserRuntime(fakePayload({ withVaultCli: true }).resources)!;
    expect(runtime.vaultServer).toBeNull();
  });

  // The runtime ships playwright without its bundled node driver binary; a
  // resolution that doesn't name a substitute leaves the browser unable to
  // launch at all.
  it("points playwright's driver at the host process's own runtime", () => {
    const runtime = resolveBrowserRuntime(fakePayload({ withVaultCli: false }).resources)!;
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
      const runtime = resolveBrowserRuntime(fakePayload({ withVaultCli: false }).resources)!;
      expect(runtime.env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(runtime.env.PLAYWRIGHT_NODEJS_PATH).toBe(process.execPath);
    } finally {
      Reflect.deleteProperty(process.versions, "electron");
    }
  });

  it("lets an explicit PLAYWRIGHT_NODEJS_PATH win over the host runtime", () => {
    process.env.PLAYWRIGHT_NODEJS_PATH = "/usr/local/bin/node";
    const runtime = resolveBrowserRuntime(fakePayload({ withVaultCli: false }).resources)!;
    expect(runtime.env.PLAYWRIGHT_NODEJS_PATH).toBe("/usr/local/bin/node");
  });

  it("lets an explicit SEED_VAULT_BW win over the bundled copy", () => {
    process.env.SEED_VAULT_BW = "/usr/local/bin/bw";
    const runtime = resolveBrowserRuntime(fakePayload({ withVaultCli: true }).resources)!;
    expect(runtime.env.SEED_VAULT_BW).toBe("/usr/local/bin/bw");
  });
});
