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
import { withoutVaultSecrets } from "./childEnv.js";

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

/** Resolves once the process is gone, or after `timeoutMs` if it will not go. */
function exited(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class VaultServer {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  /** Whether the RUNNING process was started with registration open. */
  private acceptingSignups = false;
  /** Up AND holding this machine's account. Liveness alone is not enough: a
   *  vault that started but failed to bootstrap has nothing to sign in to. */
  private ready = false;
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
   * Start it and wait until the port answers and this machine has its account.
   * Idempotent, and every concurrent caller awaits the SAME startup: the first
   * one used to set `child` before bootstrapping, so a second caller returned
   * immediately and ran its broker against a vault with no account in it yet.
   */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.ready) return Promise.resolve();
    this.starting = this.launch()
      .then(() => this.closeSignups())
      .then(() => {
        this.ready = true;
      })
      .catch((error: unknown) => {
        // A live process that never got its account would otherwise be read as
        // "already started" by the next caller, and the broker would run
        // against an empty vault. Take it down so the next call retries.
        this.stop();
        throw error;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private async launch(): Promise<void> {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const { cert, key } = this.ensureCert();
    const openForSignup = this.needsAccount();
    this.acceptingSignups = openForSignup;

    const child = spawn(this.cfg.binary, [], {
      env: {
        ...withoutVaultSecrets(process.env),
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
        SIGNUPS_ALLOWED: openForSignup ? "true" : "false",
      },
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    this.child = child;
    // Guarded on identity: a retry can have this one dying while its successor
    // is already running, and clearing `child` then would leave the live vault
    // untracked — `stop()` would never kill it, and it would hold the port for
    // the rest of the session.
    child.once("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.ready = false;
      }
    });

    const deadline = Date.now() + (this.cfg.startTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (await this.portOpen()) {
        await this.bootstrap();
        // `stop()` while we were bootstrapping means this vault is already
        // gone; reporting it started would hand the next caller nothing.
        if (this.child !== child) throw new Error("vault server was stopped during startup");
        return;
      }
      if (this.child !== child) throw new Error("vault server exited during startup");
      await new Promise((r) => setTimeout(r, 250));
    }
    this.stop();
    throw new Error(`vault server did not open ${this.url} in time`);
  }

  /**
   * Registration is open only while this machine is getting its one account —
   * a window of a few hundred milliseconds on first run, not the rest of the
   * session. Left open, anything running as the user could add accounts to the
   * vault, so the process that created the account is replaced by one that
   * refuses to create any more.
   */
  private async closeSignups(): Promise<void> {
    if (!this.acceptingSignups) return;
    const dying = this.child;
    this.stop();
    // Wait for it to actually go. SIGTERM is asynchronous, and the replacement
    // decides it is up by finding the port open — which the process being
    // replaced is still holding, so without this the "closed" vault can report
    // itself started while the one accepting signups is the one still serving.
    if (dying) await exited(dying);
    await this.launch(); // needsAccount() is false now, so this one is closed
  }

  private needsAccount(): boolean {
    return !!this.cfg.person && !vaultAccountExists(this.dataDir);
  }

  /** The one account for this vault: what the page and the agent both use. */
  get account() {
    return vaultAccount(this.dataDir);
  }

  /**
   * First run only: create the account the broker signs in as. A vault without
   * its account is not a started vault, so a failure here surfaces to the
   * caller and takes the process down; the next call starts over.
   */
  private async bootstrap(): Promise<void> {
    const person = this.cfg.person;
    if (!person || !this.needsAccount()) return;
    await ensureVaultAccount(this.url, this.dataDir, person, this.certPath);
  }

  /** Kill the process group, so nothing it spawned outlives the app. */
  stop(): void {
    this.ready = false;
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
