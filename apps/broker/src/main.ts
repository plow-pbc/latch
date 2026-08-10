#!/usr/bin/env node
/**
 * domo-broker (TypeScript) — the rendezvous daemon + provisioner CLI.
 * Twin of Sources/domo-broker/main.swift; same flags, same subcommands, same
 * on-disk layout, so it is a drop-in replacement for the Swift daemon.
 *
 *   domo-broker --home <dir>                                        (Unix, local)
 *   domo-broker --home <dir> --agent-listen wss://0.0.0.0:8443/ \
 *               --device-listen wss://0.0.0.0:8444/ --public-host broker.example \
 *               --require-enrollment
 *   domo-broker connect-string | issue-agent | enroll-device | pending |
 *               approve-pairing | revoke-agent | create-agent
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJSON,
  compactString,
  deepLink,
  DomoConnection,
  DomoPaths,
  JSONValue,
  KeyPair,
} from "@domo/protocol";
import {
  SocketServer,
  TLSServerIdentity,
  WebSocketListener,
  spkiPinOfDerCertificate,
} from "@domo/transport";
import { Broker, BrokerStore } from "@domo/broker-core";

function parseArgs(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg.startsWith("--") && i + 1 < args.length && !args[i + 1]!.startsWith("--")) {
      result.set(arg.slice(2), args[i + 1]!);
      i += 2;
    } else if (arg.startsWith("--")) {
      result.set(arg.slice(2), ""); // bare flag
      i += 1;
    } else {
      i += 1;
    }
  }
  return result;
}

/** Overlay a JSON config file onto parsed CLI options — CLI wins. */
function withConfig(options: Map<string, string>): Map<string, string> {
  const configPath = options.get("config");
  if (!configPath) return options;
  let obj: { [k: string]: unknown };
  try {
    obj = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return options;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (options.has(key)) continue;
    if (typeof value === "boolean") {
      if (value) options.set(key, "");
    } else if (typeof value === "string") {
      options.set(key, value);
    } else if (typeof value === "number") {
      options.set(key, String(value));
    }
  }
  return options;
}

const argv = process.argv.slice(2);
const defaultHome = DomoPaths.defaultHome;

interface BrokerEndpoints {
  agentURL: string;
  deviceURL: string;
  pin?: string;
  authenticate: boolean;
}

function endpointsPath(home: string): string {
  return path.join(home, "broker/endpoints.json");
}

function loadEndpoints(home: string): BrokerEndpoints | null {
  try {
    return JSON.parse(fs.readFileSync(endpointsPath(home), "utf8"));
  } catch {
    return null;
  }
}

function saveEndpoints(e: BrokerEndpoints, home: string): void {
  fs.mkdirSync(path.dirname(endpointsPath(home)), { recursive: true });
  fs.writeFileSync(endpointsPath(home), JSON.stringify(e, null, 2) + "\n");
}

function runOpenSSL(args: string[]): boolean {
  try {
    execFileSync("openssl", args, { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/** Self-signed broker identity under home/tls (PEM + P12), generated on first run. */
function ensureBrokerCert(
  home: string,
  publicHost: string,
): { certPath: string; keyPath: string; p12Path: string; password: string } | null {
  const tlsDir = path.join(home, "tls");
  const p12 = path.join(tlsDir, "broker-identity.p12");
  const passFile = path.join(tlsDir, "p12.pass");
  const key = path.join(tlsDir, "broker-key.pem");
  const cert = path.join(tlsDir, "broker-cert.pem");
  if (fs.existsSync(p12) && fs.existsSync(cert) && fs.existsSync(key) && fs.existsSync(passFile)) {
    return {
      certPath: cert,
      keyPath: key,
      p12Path: p12,
      password: fs.readFileSync(passFile, "utf8").trim(),
    };
  }
  fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
  const password = crypto.randomUUID();
  if (
    !runOpenSSL(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]) ||
    !runOpenSSL([
      "req", "-x509", "-new", "-key", key, "-out", cert,
      "-days", "3650", "-subj", `/CN=${publicHost}`, "-sha256",
    ]) ||
    !runOpenSSL([
      "pkcs12", "-export", "-inkey", key, "-in", cert,
      "-out", p12, "-passout", `pass:${password}`, "-name", "domo",
    ])
  ) {
    return null;
  }
  fs.writeFileSync(passFile, password);
  fs.chmodSync(passFile, 0o600);
  return { certPath: cert, keyPath: key, p12Path: p12, password };
}

/** Extract the leaf cert PEM from a P12 (for pin computation). */
function certFromP12(p12Path: string, password: string): Buffer | null {
  try {
    return execFileSync(
      "openssl",
      ["pkcs12", "-in", p12Path, "-clcerts", "-nokeys", "-passin", `pass:${password}`],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return null;
  }
}

function print(value: JSONValue): void {
  process.stdout.write(canonicalJSON(value) + "\n");
}

function fail(message: string, code = 2): never {
  process.stderr.write(message + "\n");
  process.exit(code);
}

// MARK: Subcommands

const sub = argv[0];

if (sub === "create-agent") {
  const options = withConfig(parseArgs(argv.slice(1)));
  const home = options.get("home") ?? defaultHome;
  const record = new BrokerStore(home).createAgent(options.get("name") ?? "Agent");
  print({ token: record.token, agent_id: record.agentId, public_key: record.publicKeyBase64 });
  process.exit(0);
}

if (sub === "issue-agent") {
  const options = withConfig(parseArgs(argv.slice(1)));
  const home = options.get("home") ?? defaultHome;
  const ep = loadEndpoints(home);
  if (!ep) fail("issue-agent: no broker endpoints found — start the broker once so it records its address.");
  const name = options.get("name") ?? "Agent";
  const record = new BrokerStore(home).createAgent(name);
  const conn: DomoConnection = { url: ep.agentURL, pin: ep.pin, token: record.token, name, authenticate: false };
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const shim = path.join(selfDir, "../../mcp/dist/main.js");
  const mcpConfig = {
    mcpServers: {
      domo: {
        type: "stdio",
        command: "node",
        args: [shim],
        env: { DOMO_CONNECTION: compactString(conn) },
      },
    },
  };
  const command = `claude --strict-mcp-config --mcp-config '${canonicalJSON(mcpConfig as JSONValue)}' --allowedTools mcp__domo`;
  process.stdout.write(
    `Agent "${name}" (${record.agentId}) — run an ephemeral Claude session (nothing persists):\n\n` +
      `  ${command}\n\n` +
      `Add a prompt if you like — it MUST come first: claude "do X" --strict-mcp-config …\n\n` +
      `Raw connection string (if you need it elsewhere): ${compactString(conn)}\n`,
  );
  process.exit(0);
}

if (sub === "connect-string") {
  const options = withConfig(parseArgs(argv.slice(1)));
  const home = options.get("home") ?? defaultHome;
  const ep = loadEndpoints(home);
  if (!ep) fail("connect-string: no broker endpoints found — start the broker once first.");
  const conn: DomoConnection = {
    url: ep.deviceURL, pin: ep.pin, name: "Domo broker", authenticate: ep.authenticate,
  };
  process.stdout.write(
    `Connect the Domo app — enter these in Settings:\n` +
      `  Broker URL:       ${ep.deviceURL}\n` +
      `  Certificate pin:  ${ep.pin ?? "(none — CA-signed cert)"}\n\n` +
      `(Or paste this one connection string instead — it bundles both:)\n  ${compactString(conn)}\n\n` +
      `Deep link (open on the Mac):  ${deepLink(conn)}\n`,
  );
  process.exit(0);
}

if (sub === "enroll-device") {
  const options = withConfig(parseArgs(argv.slice(1)));
  const home = options.get("home") ?? defaultHome;
  const pubkey = options.get("pubkey");
  if (!pubkey) fail("enroll-device: --pubkey <base64> required (see `domo-device identity`)");
  const deviceId = options.get("device-id") ?? KeyPair.fingerprintOfPublicKeyBase64(pubkey);
  const record = new BrokerStore(home).enrollDevice(deviceId, options.get("name") ?? "Mac", pubkey);
  print({ device_id: record.deviceId, name: record.name });
  process.exit(0);
}

if (sub === "pending") {
  const options = withConfig(parseArgs(argv.slice(1)));
  const home = options.get("home") ?? defaultHome;
  const pending = new BrokerStore(home).pendingPairings();
  if (pending.length === 0) {
    process.stdout.write("No pending pairings.\n");
    process.exit(0);
  }
  process.stdout.write("Pending pairings — approve the one whose code matches the Mac's screen:\n\n");
  for (const p of pending) {
    process.stdout.write(`  code ${p.code}   ${p.name} (${p.deviceId})\n`);
  }
  process.stdout.write(`\n  domo-broker approve-pairing --home ${home} --code <code>\n`);
  process.exit(0);
}

if (sub === "approve-pairing") {
  const options = withConfig(parseArgs(argv.slice(1)));
  const home = options.get("home") ?? defaultHome;
  const code = options.get("code");
  if (!code) fail("approve-pairing: --code required (see `domo-broker pending`)");
  const record = new BrokerStore(home).approvePairing(code);
  if (!record) fail(`approve-pairing: no pending pairing with code ${code}`, 1);
  print({ enrolled: record.deviceId, name: record.name });
  process.exit(0);
}

if (sub === "revoke-agent") {
  const options = withConfig(parseArgs(argv.slice(1)));
  const home = options.get("home") ?? defaultHome;
  const agentId = options.get("agent-id");
  if (!agentId) fail("revoke-agent: --agent-id required");
  new BrokerStore(home).revokeAgent(agentId);
  print({ revoked: agentId });
  process.exit(0);
}

// MARK: Daemon

const options = withConfig(parseArgs(argv));
const home = options.get("home") ?? defaultHome;
const runDir = path.join(home, "run");
fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

const agentSocket = options.get("agent-socket") ?? path.join(runDir, "agent.sock");
const deviceSocket = options.get("device-socket") ?? path.join(runDir, "device.sock");

function listenPort(urlString: string): number | null {
  try {
    const url = new URL(urlString);
    return url.port ? Number(url.port) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  let broker: Broker;
  let startupConnectString: string | null = null;
  let deviceURLOut: string | null = null;
  let pinOut: string | undefined;
  let publicHostOut = "";

  const agentListen = options.get("agent-listen");
  const deviceListen = options.get("device-listen");
  if (agentListen !== undefined && deviceListen !== undefined) {
    const agentPort = listenPort(agentListen);
    const devicePort = listenPort(deviceListen);
    if (agentPort === null || devicePort === null) {
      fail("domo-broker: --agent-listen/--device-listen must be ws(s)://host:PORT");
    }
    const wantsTLS =
      agentListen.startsWith("wss://") || deviceListen.startsWith("wss://") || options.has("tls-p12");
    const publicHost = options.get("public-host") ?? "127.0.0.1";
    const requireEnrollment = options.has("require-enrollment");

    let identity: TLSServerIdentity | null = null;
    let pin: string | undefined;
    if (wantsTLS) {
      const explicit = options.get("tls-p12");
      if (explicit !== undefined) {
        identity = { pfxPath: explicit, passphrase: options.get("tls-password") ?? "" };
        const certPem = certFromP12(explicit, options.get("tls-password") ?? "");
        pin = certPem ? (spkiPinOfDerCertificate(certPem) ?? undefined) : undefined;
      } else {
        const generated = ensureBrokerCert(home, publicHost);
        if (!generated) {
          fail("domo-broker: could not create/find a TLS cert (is `openssl` on PATH?)");
        }
        identity = { certPath: generated.certPath, keyPath: generated.keyPath };
        pin = spkiPinOfDerCertificate(fs.readFileSync(generated.certPath)) ?? undefined;
      }
    }

    const scheme = identity ? "wss" : "ws";
    const agentURL = `${scheme}://${publicHost}:${agentPort}/`;
    const deviceURL = `${scheme}://${publicHost}:${devicePort}/`;

    const agentListener = new WebSocketListener(agentPort, identity);
    const deviceListener = new WebSocketListener(devicePort, identity);
    broker = new Broker(home, agentListener, deviceListener, agentURL, requireEnrollment);

    saveEndpoints({ agentURL, deviceURL, pin, authenticate: requireEnrollment }, home);
    startupConnectString = compactString({
      url: deviceURL, pin, name: "Domo broker", authenticate: requireEnrollment,
    });
    deviceURLOut = deviceURL;
    pinOut = pin;
    publicHostOut = publicHost;
  } else {
    broker = Broker.overUnixSockets(home, agentSocket, deviceSocket);
  }

  // Advertise the sibling shim (spawn_agent responses) when it is built.
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const shim = path.resolve(selfDir, "../../mcp/dist/main.js");
  if (fs.existsSync(shim)) broker.mcpShimPath = shim;

  await broker.start();

  const agentAddr = options.get("agent-listen") ?? agentSocket;
  const deviceAddr = options.get("device-listen") ?? deviceSocket;
  process.stdout.write(`domo-broker listening agent=${agentAddr} device=${deviceAddr}\n`);
  if (startupConnectString) {
    const localHost = publicHostOut === "127.0.0.1" || publicHostOut === "localhost";
    process.stdout.write(
      `\nConnect the Domo app — enter these in Settings:\n` +
        `  Broker URL:       ${deviceURLOut}\n` +
        `  Certificate pin:  ${pinOut ?? "(none — CA-signed cert)"}\n` +
        (localHost
          ? `\n⚠ public-host is ${publicHostOut} (local only). For another machine, restart with\n` +
            `  --public-host <this broker's reachable IP or hostname> so the URL resolves there.\n`
          : "") +
        `\n(Or paste this one connection string instead — it bundles both:)\n  ${startupConnectString}\n` +
        `\nIssue an agent:  domo-broker issue-agent --home ${home} --name <name>\n\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`domo-broker failed to start: ${error}\n`);
  process.exit(1);
});
