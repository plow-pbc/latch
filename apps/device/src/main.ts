#!/usr/bin/env node
/**
 * domo-device (TypeScript) — headless device runner. Twin of
 * Sources/domo-device/main.swift: the identical device core the desktop app
 * uses, with a scripted policy instead of dialogs (DESIGN.md §10).
 *
 *   domo-device --home <dir> --broker <device.sock | ws(s)://…> [--name <name>]
 *               [--policy <config.json>] [--pin <spki>] [--authenticate]
 *   domo-device identity [--home <dir>] [--name <name>]
 *   domo-device pair --broker wss://host:port/ [--pin <spki>] [--code <code>]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import {
  canonicalJSON,
  DomoPaths,
  JSONValue,
} from "@domo/protocol";
import {
  PeerTrustEvaluator,
  SPKIPinningEvaluator,
  WebSocketDialer,
} from "@domo/transport";
import { DeviceAgent, HeadlessPolicy, loadOrCreateIdentity } from "@domo/device-core";

function parseArgs(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg.startsWith("--") && i + 1 < args.length && !args[i + 1]!.startsWith("--")) {
      result.set(arg.slice(2), args[i + 1]!);
      i += 2;
    } else if (arg.startsWith("--")) {
      result.set(arg.slice(2), "");
      i += 1;
    } else {
      i += 1;
    }
  }
  return result;
}

const rawArgs = process.argv.slice(2);

function print(value: JSONValue): void {
  process.stdout.write(canonicalJSON(value) + "\n");
}

if (rawArgs[0] === "identity") {
  const options = parseArgs(rawArgs.slice(1));
  const home = options.get("home") ?? DomoPaths.defaultHome;
  const identity = loadOrCreateIdentity(home, options.get("name") ?? os.hostname());
  print({
    device_id: identity.deviceId,
    name: identity.name,
    publicKey: identity.keyPair.publicKeyBase64,
  });
  process.exit(0);
}

async function pairMain(): Promise<void> {
  const options = parseArgs(rawArgs.slice(1));
  const home = options.get("home") ?? DomoPaths.defaultHome;
  const brokerArg = options.get("broker");
  if (!brokerArg || !brokerArg.startsWith("ws")) {
    process.stderr.write("pair: --broker wss://host:port/ required\n");
    process.exit(2);
  }
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code =
    options.get("code") ??
    Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  const policy = new HeadlessPolicy({ access: "deny", intent: "deny" });
  const device = new DeviceAgent(home, options.get("name") ?? os.hostname(), policy);
  const pin = options.get("pin");
  const trust = pin ? new SPKIPinningEvaluator([{ sha256Base64: pin }]) : null;
  process.stdout.write(`Pairing code: ${code}\n`);
  const ok = await device.pair(new WebSocketDialer(brokerArg, trust), code);
  if (ok) {
    process.stdout.write(
      `Submitted. On the broker, approve it:\n  domo-broker approve-pairing --code ${code}\n` +
        `Then start the device normally with --authenticate.\n\n`,
    );
    process.exit(0);
  }
  process.stderr.write("pair: broker did not acknowledge the request\n");
  process.exit(1);
}

if (rawArgs[0] === "pair") {
  pairMain().catch((error) => {
    process.stderr.write(`pair failed: ${error}\n`);
    process.exit(1);
  });
} else {
  main().catch((error) => {
    process.stderr.write(`domo-device failed to start: ${error}\n`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const options = parseArgs(rawArgs);
  const home = options.get("home") ?? DomoPaths.defaultHome;
  const brokerSocket = options.get("broker") ?? DomoPaths.deviceSocket(home);

  const policyPath = options.get("policy");
  // Without a policy file the headless runner denies everything: silent
  // auto-approval must always be an explicit, visible choice.
  const policy = policyPath
    ? HeadlessPolicy.fromFile(policyPath)
    : new HeadlessPolicy({ access: "deny", intent: "deny" });

  const device = new DeviceAgent(home, options.get("name") ?? os.hostname(), policy);
  device.onConnectionClosed = () => {
    process.stderr.write("domo-device: broker connection closed\n");
    process.exit(1);
  };

  if (brokerSocket.startsWith("ws://") || brokerSocket.startsWith("wss://")) {
    const authenticate = options.has("authenticate");
    let trust: PeerTrustEvaluator | null = null;
    const pin = options.get("pin");
    if (pin) trust = new SPKIPinningEvaluator([{ sha256Base64: pin }]);
    await device.connect(new WebSocketDialer(brokerSocket, trust), true, authenticate);
  } else {
    await device.connectUnix(brokerSocket);
  }

  // Test/dev affordance: drive the Mac-initiated spawn flow at startup and
  // write the resulting agent token to a file (DESIGN.md §10).
  const spawnGoal = options.get("spawn-goal");
  if (spawnGoal !== undefined) {
    const spawned = await device.requestSpawnAgent(spawnGoal);
    const out = options.get("spawn-token-out");
    if (out) fs.writeFileSync(out, canonicalJSON(spawned));
  }

  process.stdout.write(`domo-device ready id=${device.identity.deviceId}\n`);
  // Keep the process alive; the RPC connection drives everything.
  setInterval(() => {}, 1 << 30);
}
