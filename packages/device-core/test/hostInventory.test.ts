/**
 * The standing inventory: what the Settings pane and `plow_device_status`
 * both read. The rows that reach macOS are scripted at the probe seam; the
 * self-checks run through a scripted child runner, and once through the real
 * executor on a Mac.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTOMATION_TARGETS,
  CONSENT_FOLDERS,
  DeviceAgent,
  HeadlessPolicy,
  hostInventory,
  nodeProbes,
  requestFolderAccess,
  scriptedProbes,
} from "@domo/device-core";

const ON_MAC = process.platform === "darwin";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-inv-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A child runner that answers from a table and records what ran. */
function runner(table: Record<string, { exitCode: number; output?: string }>) {
  const ran: string[][] = [];
  const run = async (argv: string[]) => {
    ran.push(argv);
    const hit = table[argv[0]!] ?? { exitCode: 127, output: "not scripted" };
    return { exitCode: hit.exitCode, output: hit.output ?? "" };
  };
  return { run, ran };
}

describe("hostInventory", () => {
  it("reports every row from one snapshot, with a timestamp", async () => {
    const dir = tempDir();
    const chat = path.join(dir, "chat.db");
    fs.writeFileSync(chat, "x");
    const probes = scriptedProbes({
      automation: { Messages: "granted", Contacts: "not_asked" },
      permissions: { accessibility: "denied", contacts: "granted", calendars: "not_asked" },
    });
    const { run, ran } = runner({ "/usr/bin/true": { exitCode: 0 }, "/usr/bin/head": { exitCode: 0 } });
    const inv = await hostInventory({
      probes,
      ownerHome: dir,
      runSandboxed: run,
      vaultKey: () => ({ status: "ok" }),
      fullDiskPaths: [path.join(dir, "absent.db"), chat],
    });
    expect(inv.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(inv.full_disk_access.granted).toBe(true);
    expect(inv.full_disk_access.probes).toEqual([
      { path: path.join(dir, "absent.db"), outcome: "ENOENT" },
      { path: chat, outcome: "ok" },
    ]);
    expect(inv.automation).toEqual([
      { target: "Messages", status: "granted" },
      { target: "Contacts", status: "not_asked" },
    ]);
    expect(inv.automation_queryable).toBe(true);
    expect(inv.permissions).toEqual([
      { permission: "accessibility", status: "denied" },
      { permission: "contacts", status: "granted" },
      { permission: "calendars", status: "not_asked" },
    ]);
    expect(inv.sandbox).toEqual({ status: "ok", detail: null });
    // Attribution is checked against the file the app's own probe opened.
    expect(inv.child_attribution).toEqual({ status: "ok", detail: null });
    expect(ran).toContainEqual(["/usr/bin/head", "-c", "1", "--", chat]);
    expect(inv.vault_key).toEqual({ status: "ok", reason: null });
  });

  it("asks about the targets the built-in skills drive", () => {
    expect(AUTOMATION_TARGETS).toEqual(["Messages", "Contacts"]);
  });

  it("without Full Disk Access, attribution is not applicable and nothing is read through a child", async () => {
    const dir = tempDir();
    const { run, ran } = runner({ "/usr/bin/true": { exitCode: 0 } });
    const inv = await hostInventory({
      probes: scriptedProbes(),
      ownerHome: dir,
      runSandboxed: run,
      vaultKey: null,
      fullDiskPaths: [path.join(dir, "absent.db")],
    });
    expect(inv.full_disk_access.granted).toBe(false);
    expect(inv.child_attribution.status).toBe("not_applicable");
    expect(ran.map((a) => a[0])).toEqual(["/usr/bin/true"]);
    // No helper: every target unknown, and the row says the question could
    // not be asked rather than that the answer is no.
    expect(inv.automation.every((a) => a.status === "unknown")).toBe(true);
    expect(inv.automation_queryable).toBe(false);
    expect(inv.permissions.every((p) => p.status === "unknown")).toBe(true);
    expect(inv.vault_key).toEqual({ status: "absent", reason: "this Mac has no vault" });
  });

  it("a child that cannot read what the app can is broken attribution; a sandbox that will not spawn is failed", async () => {
    const dir = tempDir();
    const chat = path.join(dir, "chat.db");
    fs.writeFileSync(chat, "x");
    const { run } = runner({
      "/usr/bin/true": { exitCode: 1, output: "sandbox-exec: profile error" },
      "/usr/bin/head": { exitCode: 1, output: "head: chat.db: Operation not permitted" },
    });
    const inv = await hostInventory({
      probes: scriptedProbes(),
      ownerHome: dir,
      runSandboxed: run,
      vaultKey: () => ({ status: "locked", reason: "the Keychain item belongs to another build" }),
      fullDiskPaths: [chat],
    });
    expect(inv.sandbox.status).toBe("failed");
    expect(inv.sandbox.detail).toMatch(/exit 1: sandbox-exec: profile error/);
    expect(inv.child_attribution.status).toBe("broken");
    expect(inv.child_attribution.detail).toMatch(/refused a file the app itself can read/);
    expect(inv.vault_key).toEqual({ status: "locked", reason: "the Keychain item belongs to another build" });
  });

  it("a runner that throws becomes a failed row, not a thrown inventory", async () => {
    const dir = tempDir();
    const chat = path.join(dir, "chat.db");
    fs.writeFileSync(chat, "x");
    const inv = await hostInventory({
      probes: scriptedProbes(),
      ownerHome: dir,
      runSandboxed: async () => {
        throw new Error("spawn EACCES");
      },
      vaultKey: () => {
        throw new Error("keychain unavailable");
      },
      fullDiskPaths: [chat],
    });
    expect(inv.sandbox).toEqual({ status: "failed", detail: "spawn EACCES" });
    expect(inv.child_attribution).toEqual({ status: "broken", detail: "spawn EACCES" });
    expect(inv.vault_key).toEqual({ status: "unknown", reason: "keychain unavailable" });
  });

  it("on a host with no sandboxed executor, the sandbox rows say so", async () => {
    const dir = tempDir();
    const inv = await hostInventory({
      probes: scriptedProbes(),
      ownerHome: dir,
      runSandboxed: null,
      vaultKey: null,
      fullDiskPaths: [],
    });
    expect(inv.sandbox).toEqual({ status: "failed", detail: "no sandboxed executor on this host" });
    expect(inv.child_attribution.status).toBe("not_applicable");
  });
});

describe.skipIf(!ON_MAC)("DeviceAgent.hostInventory through the real executor", () => {
  it("proves sandbox-exec spawns, and leaves no run in the audit log", async () => {
    const home = tempDir();
    const device = new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "allow_once" }), null, home);
    const inv = await device.hostInventory();
    expect(inv.sandbox).toEqual({ status: "ok", detail: null });
    // The fixture home has none of the protected files, so FDA reads as not
    // granted there — the honest answer on a throwaway home.
    expect(inv.full_disk_access.granted).toBe(false);
    expect(inv.child_attribution.status).toBe("not_applicable");
    expect(inv.vault_key.status).toBe("absent");
    // Self-checks are not operations: nothing in the log.
    expect(device.audit.entries()).toEqual([]);
  });
});

describe("requestFolderAccess — the deliberate touch, with the owner present", () => {
  it("names each folder's switch and what macOS decided, one folder at a time", async () => {
    const home = "/Users/probe";
    const probes = scriptedProbes({
      openAsApp: {
        [`${home}/Desktop`]: "ok",
        [`${home}/Documents`]: "EPERM",
        [`${home}/Downloads`]: "hung",
      },
    });
    const results = await requestFolderAccess(home, { probes });
    expect(results).toEqual([
      { folder: "Desktop", permission: "files_desktop", label: "Files and Folders > Desktop Folder", status: "granted" },
      { folder: "Documents", permission: "files_documents", label: "Files and Folders > Documents Folder", status: "denied" },
      { folder: "Downloads", permission: "files_downloads", label: "Files and Folders > Downloads Folder", status: "unanswered" },
    ]);
    // Sequential: one dialog at a time is what a person can answer.
    expect(probes.calls).toEqual([
      `openAsApp ${home}/Desktop`,
      `openAsApp ${home}/Documents`,
      `openAsApp ${home}/Downloads`,
    ]);
  });

  it("reports a folder that is not there as missing, for real", async () => {
    const home = tempDir();
    fs.mkdirSync(path.join(home, "Desktop"));
    const results = await requestFolderAccess(home, { probes: nodeProbes({ ownerHome: home, timeoutMs: 1_000 }) });
    expect(results.map((r) => r.status)).toEqual(["granted", "missing", "missing"]);
  });

  it("covers exactly the three folders with their own switch", () => {
    expect(CONSENT_FOLDERS.map((f) => f.folder)).toEqual(["Desktop", "Documents", "Downloads"]);
  });
});
