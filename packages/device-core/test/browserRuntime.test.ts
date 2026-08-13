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
});

/**
 * A packaged Resources dir: python + server (+ vault CLI) under
 * browser-runtime/, the layout electron-builder produces. Returns the dir to
 * hand to resolveBrowserRuntime.
 */
function fakePayload(opts: { withVaultCli: boolean; withVaultServer?: boolean }): { resources: string; root: string } {
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
  if (opts.withVaultServer) {
    fs.mkdirSync(path.join(root, "vault-server", arch), { recursive: true });
    fs.writeFileSync(path.join(root, "vault-server", arch, "vaultwarden"), "");
    fs.mkdirSync(path.join(root, "vault-server", "web-vault"), { recursive: true });
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
    const { resources, root } = fakePayload({ withVaultCli: true, withVaultServer: true });
    const runtime = resolveBrowserRuntime(resources)!;
    expect(runtime.vaultServer).toEqual({
      binary: path.join(root, "vault-server", arch, "vaultwarden"),
      webVaultDir: path.join(root, "vault-server", "web-vault"),
    });
  });

  it("reports no vault when this build ships none, so we can still point at a hosted one", () => {
    const runtime = resolveBrowserRuntime(fakePayload({ withVaultCli: true }).resources)!;
    expect(runtime.vaultServer).toBeNull();
  });

  it("lets an explicit SEED_VAULT_BW win over the bundled copy", () => {
    process.env.SEED_VAULT_BW = "/usr/local/bin/bw";
    const runtime = resolveBrowserRuntime(fakePayload({ withVaultCli: true }).resources)!;
    expect(runtime.env.SEED_VAULT_BW).toBe("/usr/local/bin/bw");
  });
});
