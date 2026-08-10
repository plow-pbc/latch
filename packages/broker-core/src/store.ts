/**
 * Broker persistence — twin of DomoBrokerCore/BrokerStore.swift. Same on-disk
 * layout (broker/agents.json, devices.json, revoked.json, pending.json), same
 * reload-on-miss + merge-on-persist semantics, so a separate provisioner
 * process's writes are honored without a restart — and so the TS broker can
 * read a store written by the Swift broker and vice versa.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "@domo/protocol";

export interface AgentRecord {
  token: string;
  agentId: string;
  display: string;
  privateKeyBase64: string;
  publicKeyBase64: string;
  grantedDevices: string[];
  sessionGoals?: string;
}

export function agentKeyPair(record: AgentRecord): KeyPair {
  return KeyPair.fromRawRepresentation(Buffer.from(record.privateKeyBase64, "base64"));
}

export interface DeviceRecord {
  deviceId: string;
  name: string;
  publicKeyBase64: string;
}

export interface PendingPairing {
  code: string;
  deviceId: string;
  name: string;
  publicKeyBase64: string;
}

function readJSON<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJSON(file: string, value: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  if (mode !== undefined) {
    try {
      fs.chmodSync(file, mode);
    } catch {
      /* best effort */
    }
  }
}

export class BrokerStore {
  private agents = new Map<string, AgentRecord>(); // token -> record
  private devices = new Map<string, DeviceRecord>(); // deviceId -> record
  private revoked = new Set<string>();

  constructor(public readonly home: string) {
    const agents = readJSON<AgentRecord[]>(this.agentsPath);
    if (agents) for (const a of agents) this.agents.set(a.token, a);
    const devices = readJSON<DeviceRecord[]>(this.devicesPath);
    if (devices) for (const d of devices) this.devices.set(d.deviceId, d);
    const revoked = readJSON<string[]>(this.revokedPath);
    if (revoked) this.revoked = new Set(revoked);
  }

  private get agentsPath(): string {
    return path.join(this.home, "broker/agents.json");
  }
  private get devicesPath(): string {
    return path.join(this.home, "broker/devices.json");
  }
  private get revokedPath(): string {
    return path.join(this.home, "broker/revoked.json");
  }
  private get pendingPath(): string {
    return path.join(this.home, "broker/pending.json");
  }

  revokeAgent(agentId: string): void {
    this.revoked.add(agentId);
    writeJSON(this.revokedPath, [...this.revoked].sort());
  }

  isRevoked(agentId: string): boolean {
    if (this.revoked.has(agentId)) return true;
    // Reload-on-miss: honor a separate provisioner process's revocation.
    const stored = readJSON<string[]>(this.revokedPath);
    if (stored) {
      for (const id of stored) this.revoked.add(id);
    }
    return this.revoked.has(agentId);
  }

  agent(token: string): AgentRecord | null {
    const record = this.agents.get(token);
    if (record) return record;
    this.mergeAgentsFromDisk();
    return this.agents.get(token) ?? null;
  }

  /** Existing in-memory records win — disk is never ahead for a held token. */
  private mergeAgentsFromDisk(): void {
    const stored = readJSON<AgentRecord[]>(this.agentsPath);
    if (!stored) return;
    for (const record of stored) {
      if (!this.agents.has(record.token)) this.agents.set(record.token, record);
    }
  }

  createAgent(display: string, sessionGoals?: string, grantedDevices: string[] = []): AgentRecord {
    const keyPair = new KeyPair();
    const record: AgentRecord = {
      token: crypto.randomUUID().toUpperCase(),
      agentId: keyPair.fingerprint,
      display,
      privateKeyBase64: keyPair.privateKeyBase64,
      publicKeyBase64: keyPair.publicKeyBase64,
      grantedDevices,
      sessionGoals,
    };
    this.agents.set(record.token, record);
    this.persist();
    return record;
  }

  grantDevice(token: string, deviceId: string): void {
    const record = this.agents.get(token);
    if (record && !record.grantedDevices.includes(deviceId)) {
      record.grantedDevices.push(deviceId);
    }
    this.persist();
  }

  recordSessionGoals(token: string, goals: string): void {
    const record = this.agents.get(token);
    if (record) record.sessionGoals = goals;
    this.persist();
  }

  upsertDevice(device: DeviceRecord): void {
    this.devices.set(device.deviceId, device);
    this.persist();
  }

  enrollDevice(deviceId: string, name: string, publicKeyBase64: string): DeviceRecord {
    const record: DeviceRecord = { deviceId, name, publicKeyBase64 };
    this.upsertDevice(record);
    return record;
  }

  // Pairing by code (runbook Phase 3 pairing UX).

  private loadPending(): Map<string, PendingPairing> {
    const stored = readJSON<PendingPairing[]>(this.pendingPath);
    const map = new Map<string, PendingPairing>();
    if (stored) for (const p of stored) map.set(p.code, p);
    return map;
  }

  private savePending(map: Map<string, PendingPairing>): void {
    writeJSON(this.pendingPath, [...map.values()]);
  }

  addPendingPairing(code: string, deviceId: string, name: string, publicKeyBase64: string): void {
    const map = this.loadPending();
    map.set(code, { code, deviceId, name, publicKeyBase64 });
    this.savePending(map);
  }

  pendingPairings(): PendingPairing[] {
    return [...this.loadPending().values()].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  approvePairing(code: string): DeviceRecord | null {
    const map = this.loadPending();
    const pending = map.get(code);
    if (!pending) return null;
    map.delete(code);
    this.savePending(map);
    return this.enrollDevice(pending.deviceId, pending.name, pending.publicKeyBase64);
  }

  /** Reloads from disk on a miss (mirrors the agent reload-on-miss). */
  deviceById(deviceId: string): DeviceRecord | null {
    const record = this.devices.get(deviceId);
    if (record) return record;
    const stored = readJSON<DeviceRecord[]>(this.devicesPath);
    if (stored) {
      for (const d of stored) {
        if (!this.devices.has(d.deviceId)) this.devices.set(d.deviceId, d);
      }
    }
    return this.devices.get(deviceId) ?? null;
  }

  allDevices(): DeviceRecord[] {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private persist(): void {
    // Merge first so we never clobber an agent a separate create-agent process
    // wrote while we were running.
    this.mergeAgentsFromDisk();
    writeJSON(this.agentsPath, [...this.agents.values()], 0o600);
    writeJSON(this.devicesPath, [...this.devices.values()]);
  }
}
