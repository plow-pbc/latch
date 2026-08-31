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
import tls from "node:tls";
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
  /** How long a port that is listening gets to say whose vault it is. */
  identifyTimeoutMs?: number;
}

/**
 * Who is on this loopback port.
 *
 * `ours` presented the certificate in this data directory; `stranger` presented
 * another one, or nothing is listening; `silent` accepted the connection and
 * then said nothing before the deadline.
 *
 * `silent` is its own answer because it is not the same fact as `stranger`, and
 * conflating them is what put two vaultwardens on one data directory: a vault
 * of ours that is merely slow to finish its handshake read as somebody else's,
 * and the caller spawned beside it.
 */
export type PortHolder = "ours" | "stranger" | "silent";

/**
 * Does whatever is listening on this loopback port present THIS certificate?
 *
 * Exported because it is the whole identity check: the port being open says
 * nothing about whose vault is behind it, and the certificate is the only
 * thing that does.
 */
export function servesCertificate(port: number, certPath: string, timeoutMs = 1_000): Promise<PortHolder> {
  return new Promise((resolve) => {
    const ca = fs.readFileSync(certPath);
    const done = (who: PortHolder) => {
      sock.destroy();
      resolve(who);
    };
    // No SNI: it names a host, and an IP is not one — Node 26 throws on the IP
    // that Node 24 only deprecated. Identity falls to `host`, which the cert
    // `ensureCert` mints covers with an IP SAN.
    const sock = tls.connect(
      { host: "127.0.0.1", port, ca, timeout: timeoutMs },
      () => done(sock.authorized ? "ours" : "stranger"),
    );
    sock.once("error", () => done("stranger"));
    sock.once("timeout", () => done("silent"));
  });
}

export class VaultServer {
  private child: ChildProcess | null = null;
  private port: number;
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

  /**
   * Is the thing answering on this port OUR vault?
   *
   * A vault server outlives a hard quit — it is spawned in its own process
   * group so the app can kill the group, and a killed app never gets to. So
   * the port being open says nothing about WHOSE vault is behind it: an old
   * install's server, still holding 8222, will answer and then refuse our
   * certificate, which reaches the owner as "self signed certificate".
   *
   * The certificate is the identity: ours is the only one signed by the key in
   * this data directory.
   */
  private whoIsOnPort(): Promise<PortHolder> {
    return servesCertificate(this.port, this.certPath);
  }

  /**
   * Wait for the port to say who it is, up to `budgetMs`.
   *
   * A vault of ours is `silent` before it is `ours`: vaultwarden binds the
   * socket well before it is serving TLS on it. Both callers below need the
   * settled answer — one to know the server it just spawned is actually up, the
   * other to know whether the server already there is ours to join — and asking
   * once gets whichever answer the first quarter-second happened to hold.
   */
  private async settleOnPort(budgetMs: number): Promise<PortHolder> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const who = await this.whoIsOnPort();
      if (who !== "silent" || Date.now() >= deadline) return who;
      await new Promise((r) => setTimeout(r, 250));
    }
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

  /**
   * Settle on a port to serve on: this one, or the next one nobody else is
   * holding. True when our own vault is already up on it, false when it is free
   * for us to spawn on.
   *
   * Refusing to start because someone else has 8222 would leave the owner with
   * a vault they cannot open and nothing to do about it. Everything that talks
   * to the vault reads `url` from here, so moving is invisible.
   */
  private async selectPort(): Promise<boolean> {
    const first = this.port;
    for (let i = 0; i < 20; i++) {
      this.port = first + i;
      if (!(await this.portOpen())) return false;
      // Something is listening, so ask who — and wait out a slow handshake
      // before believing the answer. Treating "has not answered yet" as
      // "somebody else's" is what let a vault of ours still booting be walked
      // past, and the vault spawned beside it shared this same data directory:
      // two vaultwardens, one SQLite file.
      const who = await this.settleOnPort(this.cfg.identifyTimeoutMs ?? 10_000);
      if (who === "ours") return true; // our own server, already up
      if (who === "silent") {
        // Never spawn beside a server that will not say who it is: if it is
        // ours, a second one corrupts the database it is already holding. An
        // error the owner can act on is the safer end — the Vault tab shows it.
        throw new Error(
          `something is holding ${this.url} without answering; if it is an old copy of this app, quit it (or kill the process on port ${this.port}) and try again`,
        );
      }
    }
    this.port = first;
    throw new Error(`nothing is free between ${first} and ${first + 19} for this Mac's vault`);
  }

  private async startOnce(): Promise<void> {
    // Running, but perhaps not finished: a bootstrap that failed transiently
    // left a live process with no account, and returning here would keep the
    // vault looking empty until something restarted it. Bootstrapping is a
    // file read when there is nothing to do, so retrying it costs nothing.
    if (this.child) return this.bootstrap();
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const { cert, key } = this.ensureCert();
    // Whose server is on the port matters more than whether one is: see
    // `oursOnPort`. If ours is already up we join it; if a stranger is there,
    // we serve beside it rather than talking to it.
    if (await this.selectPort()) {
      await this.bootstrap();
      return;
    }

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

    // Up means SERVING, not bound. vaultwarden accepts on the port well before
    // it is answering TLS there, so waiting on a bare connect handed the first
    // read a server that accepts and then says nothing — the stall that reached
    // the owner as a Vault tab which never opened (#193).
    const deadline = Date.now() + (this.cfg.startTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if ((await this.whoIsOnPort()) === "ours") {
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
