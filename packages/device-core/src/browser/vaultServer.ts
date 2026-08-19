/**
 * The vault itself, running on this Mac — a bundled Vaultwarden supervised the
 * same way the browser server is: spawned into its own process group, killed
 * with the app.
 *
 * TLS is not optional: the Bitwarden clients refuse a plain http:// server even
 * on localhost, so the first run mints a self-signed cert for 127.0.0.1 and
 * both the CLI and the broker are pointed at it explicitly (they trust that one
 * file, nothing is added to the system keychain).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ensureVaultAccount, vaultAccount, vaultAccountExists } from "./vaultBootstrap.js";
import { settlePendingChange } from "./vaultCredentials.js";

export interface VaultServerConfig {
  /** The bundled `vaultwarden` binary for this arch. */
  binary: string;
  /** The prebuilt web interface (arch-independent). */
  webVaultDir: string;
  /** Writable state: database, RSA key, icon cache, our cert. */
  dataDir: string;
  /** Loopback port. Anything else would publish the vault to the network. */
  port?: number;
  /** Whose machine this is — names the account created on first run. */
  person?: string;
  startTimeoutMs?: number;
}

export class VaultServer {
  private child: ChildProcess | null = null;
  private readonly port: number;
  readonly dataDir: string;

  constructor(private readonly cfg: VaultServerConfig) {
    this.port = cfg.port ?? 8222;
    this.dataDir = cfg.dataDir;
  }

  /** https://127.0.0.1:<port> — what the CLI and the broker are pointed at. */
  get url(): string {
    return `https://127.0.0.1:${this.port}`;
  }

  /** The cert clients must trust. Handed over as a path, never installed. */
  get certPath(): string {
    return path.join(this.dataDir, "tls", "cert.pem");
  }

  /**
   * Mint a self-signed cert for 127.0.0.1 if we have none. `openssl` ships with
   * macOS, so this needs nothing bundled. Kept for 10 years: rotating it would
   * only strand the clients that already trust this file.
   */
  private ensureCert(): { cert: string; key: string } {
    const tlsDir = path.join(this.dataDir, "tls");
    const cert = path.join(tlsDir, "cert.pem");
    const key = path.join(tlsDir, "key.pem");
    if (fs.existsSync(cert) && fs.existsSync(key)) return { cert, key };
    fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert,
      "-days", "3650", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    fs.chmodSync(key, 0o600);
    return { cert, key };
  }

  private portOpen(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port: this.port });
      const done = (ok: boolean) => {
        sock.destroy();
        resolve(ok);
      };
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
      sock.setTimeout(1_000, () => done(false));
    });
  }

  /**
   * Start it and wait until the port answers. Idempotent — and idempotent for
   * CALLERS TOO: everyone awaits the same startup, rather than the second
   * caller returning early on a process that is still booting and then talking
   * to a port nobody is listening on yet.
   */
  start(): Promise<void> {
    if (!this.starting) {
      // Cleared whatever happens: a startup that failed must be retryable, and
      // a vault that exits later must be startable again. `startOnce` returns
      // immediately when the process is already up, so dropping the memo costs
      // nothing.
      this.starting = this.startOnce().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private starting: Promise<void> | null = null;

  private async startOnce(): Promise<void> {
    // Running, but perhaps not finished: a bootstrap that failed transiently
    // left a live process with no account, and returning here would keep the
    // vault looking empty until something restarted it. Bootstrapping is a
    // file read when there is nothing to do, so retrying it costs nothing.
    if (this.child) return this.bootstrap();
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const { cert, key } = this.ensureCert();

    this.child = spawn(this.cfg.binary, [], {
      env: {
        ...process.env,
        DATA_FOLDER: this.dataDir,
        WEB_VAULT_FOLDER: this.cfg.webVaultDir,
        WEB_VAULT_ENABLED: "true",
        // Loopback only. The user's own machine is the whole network here.
        ROCKET_ADDRESS: "127.0.0.1",
        ROCKET_PORT: String(this.port),
        ROCKET_TLS: `{certs="${cert}",key="${key}"}`,
        DOMAIN: this.url,
        // Open only while this machine still needs its one account, and only
        // ever on loopback. Left open, anything running as the user could add
        // accounts to the vault.
        SIGNUPS_ALLOWED: this.needsAccount() ? "true" : "false",
      },
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    this.child.once("exit", () => {
      this.child = null;
    });

    const deadline = Date.now() + (this.cfg.startTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (await this.portOpen()) {
        await this.bootstrap();
        return;
      }
      if (!this.child) throw new Error("vault server exited during startup");
      await new Promise((r) => setTimeout(r, 250));
    }
    this.stop();
    throw new Error(`vault server did not open ${this.url} in time`);
  }

  private needsAccount(): boolean {
    return !!this.cfg.person && !vaultAccountExists(this.dataDir);
  }

  /** The one account for this vault: what the page and the agent both use. */
  get account() {
    return vaultAccount(this.dataDir);
  }

  /**
   * First run only: create the account the broker signs in as. A failure here
   * must not take the vault down — the broker reports it as a locked vault,
   * which is what it is.
   */
  private async bootstrap(): Promise<void> {
    const person = this.cfg.person;
    if (!person) return;
    if (this.needsAccount()) {
      await ensureVaultAccount(this.url, this.dataDir, person, this.certPath);
      return;
    }
    // A change interrupted last time leaves two candidate pairs on disk; ask
    // the vault which one it took before anything else uses them.
    await settlePendingChange(this.url, this.dataDir, this.certPath);
  }

  /** Kill the process group, so nothing it spawned outlives the app. */
  stop(): void {
    const pid = this.child?.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    this.child = null;
  }
}
