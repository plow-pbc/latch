/**
 * Device identity + pinned agent keys — twin of DeviceIdentity.swift,
 * DeviceKeyStore.swift (file store), and KnownAgents. Same on-disk layout, so
 * a TS device reuses an identity created by the Swift device and vice versa.
 * (The Keychain-backed store is the Electron app's `safeStorage` milestone.)
 */
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "@domo/protocol";

export interface DeviceKeyStore {
  loadKey(): KeyPair | null;
  storeKey(keyPair: KeyPair): void;
}

/** v1 default: Ed25519 seed persisted in a 0600 JSON file under DOMO_HOME. */
export class FileDeviceKeyStore implements DeviceKeyStore {
  constructor(public readonly file: string) {}

  loadKey(): KeyPair | null {
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, "utf8")) as {
        privateKeyBase64?: string;
      };
      if (!stored.privateKeyBase64) return null;
      return KeyPair.fromRawRepresentation(Buffer.from(stored.privateKeyBase64, "base64"));
    } catch {
      return null;
    }
  }

  storeKey(keyPair: KeyPair): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      this.file,
      JSON.stringify({ privateKeyBase64: keyPair.privateKeyBase64 }, null, 2) + "\n",
    );
    fs.chmodSync(this.file, 0o600);
  }
}

export interface DeviceIdentity {
  deviceId: string;
  name: string;
  keyPair: KeyPair;
}

export function loadOrCreateIdentity(home: string, defaultName: string): DeviceIdentity {
  const file = path.join(home, "device/identity.json");
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
      deviceId: string;
      name: string;
      privateKeyBase64: string;
    };
    const keyPair = KeyPair.fromRawRepresentation(Buffer.from(stored.privateKeyBase64, "base64"));
    return { deviceId: stored.deviceId, name: stored.name, keyPair };
  } catch {
    /* create below */
  }
  const keyPair = new KeyPair();
  const identity: DeviceIdentity = { deviceId: keyPair.fingerprint, name: defaultName, keyPair };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        deviceId: identity.deviceId,
        name: defaultName,
        privateKeyBase64: keyPair.privateKeyBase64,
      },
      null,
      2,
    ) + "\n",
  );
  fs.chmodSync(file, 0o600);
  return identity;
}

/**
 * Agent public keys pinned at access-grant time. Revocation is authoritative
 * on the DEVICE: a revoked agent's key is dropped AND remembered, so a stale
 * or hostile broker can neither route nor silently re-pin it.
 */
export class KnownAgents {
  private keys: { [agentId: string]: string } = {};
  private revoked = new Set<string>();

  constructor(public readonly file: string) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as
        | { keys?: { [k: string]: string }; revoked?: string[] }
        | { [k: string]: string };
      if (typeof stored === "object" && stored !== null && "keys" in stored) {
        const s = stored as { keys?: { [k: string]: string }; revoked?: string[] };
        this.keys = s.keys ?? {};
        this.revoked = new Set(s.revoked ?? []);
      } else {
        // Back-compat with the pre-revocation on-disk format (a bare map).
        this.keys = stored as { [k: string]: string };
      }
    } catch {
      /* empty */
    }
  }

  pin(agentId: string, publicKey: string): void {
    // A revoked agent can never be silently re-pinned by the broker.
    if (this.revoked.has(agentId)) return;
    this.keys[agentId] = publicKey;
    this.persist();
  }

  revoke(agentId: string): void {
    delete this.keys[agentId];
    this.revoked.add(agentId);
    this.persist();
  }

  isRevoked(agentId: string): boolean {
    return this.revoked.has(agentId);
  }

  publicKeyFor(agentId: string): string | null {
    if (this.revoked.has(agentId)) return null;
    return this.keys[agentId] ?? null;
  }

  pinnedAgentIds(): string[] {
    return Object.keys(this.keys).sort();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      this.file,
      JSON.stringify({ keys: this.keys, revoked: [...this.revoked] }, null, 2) + "\n",
    );
  }
}
