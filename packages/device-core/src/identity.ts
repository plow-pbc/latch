/**
 * Device identity — twin of DeviceIdentity.swift and DeviceKeyStore.swift
 * (file store). Agent public keys are no longer pinned here: with no
 * agent-held signing key there is nothing to pin, and an agent credential is
 * now issued and revoked by the relay.
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
