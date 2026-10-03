/**
 * Syncing logins from a 1Password vault (service account, `op` CLI) into the
 * vault, with nobody at the Mac. `op` is a scripted function here: the list and
 * per-item JSON are the shapes `op item list|get --format json` print. The rules
 * under test: it lands items through the vault's own save, a second pass changes
 * nothing, a rotated password updates in place, and no value ever appears in
 * anything the sync returns or the audit log records.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalVault } from "../src/browser/localVault.js";
import { VaultKeyStore } from "../src/browser/vaultKeyStore.js";
import { VaultStore } from "../src/browser/vaultStore.js";
import { loginFromOpItem, syncFromOnePassword, type OpRunner } from "../src/browser/onePasswordSync.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempVault(): { vault: LocalVault; auditPath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-sync-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const auditPath = path.join(dir, "credential-audit.log");
  return { vault: new LocalVault(dir, new VaultKeyStore(dir, "test"), auditPath), auditPath, dir };
}

const counts = (o: Partial<Record<string, number>>) => ({
  excluded: 0, saved: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, ...o,
});

function opLogin(id: string, title: string, password: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    category: "LOGIN",
    fields: [
      { id: "username", type: "STRING", purpose: "USERNAME", label: "username", value: `${id}@plow.co` },
      { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: password },
      { id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", value: "" },
    ],
    urls: [{ label: "website", primary: true, href: `https://${id}.example.com/login` }],
    ...extra,
  };
}

/** A scripted `op`: `items` by id; `list` answers what the vault holds now. */
function fakeOp(items: Record<string, unknown>, calls: string[][] = []): OpRunner {
  return async (args) => {
    calls.push(args);
    if (args[0] === "item" && args[1] === "list") {
      return JSON.stringify(Object.entries(items).map(([id, it]) => ({ id, title: (it as { title: string }).title })));
    }
    if (args[0] === "item" && args[1] === "get") {
      const item = items[args[2]!];
      if (!item) throw new Error("item not found");
      return JSON.stringify(item);
    }
    throw new Error("unexpected op call");
  };
}

describe("loginFromOpItem", () => {
  it("reads username, password, site and one-time key from op's field purposes", () => {
    const otp = { id: "otp", type: "OTP", label: "one-time password", value: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" };
    const base = opLogin("restream", "Restream", "s3cret");
    const login = loginFromOpItem({ ...base, fields: [...base.fields, otp] });
    expect(login).toMatchObject({
      title: "Restream",
      username: "restream@plow.co",
      password: "s3cret",
      urls: ["https://restream.example.com/login"],
    });
    expect(login!.totp).not.toBe("");
  });

  it("is null for what the vault could never fill: not a login, or no site", () => {
    expect(loginFromOpItem({ title: "Stripe Keys", category: "API_CREDENTIAL" })).toBeNull();
    expect(loginFromOpItem({ ...opLogin("x", "Box", "pw-no-site"), urls: [] })).toBeNull();
  });
});

describe("syncFromOnePassword", () => {
  it("lands logins through the vault's own save, then a second pass changes nothing", async () => {
    const { vault, auditPath } = tempVault();
    const items = { restream: opLogin("restream", "Restream", "rs-secret"), luma: opLogin("luma", "Luma", "lu-secret") };
    const calls: string[][] = [];
    const first = await syncFromOnePassword(vault, "Agents", fakeOp(items, calls));
    expect(first).toEqual(counts({ saved: 2 }));
    expect(calls[0]).toEqual(["item", "list", "--vault", "Agents", "--categories", "Login", "--format", "json"]);
    expect(calls[1]).toContain("--reveal");

    const listed = await vault.list();
    const luma = listed.find((i) => i.title === "Luma")!;
    expect(await vault.reveal(luma.id, "password")).toBe("lu-secret");

    const second = await syncFromOnePassword(vault, "Agents", fakeOp(items));
    expect(second).toEqual(counts({ unchanged: 2 }));
    expect((await vault.list()).length).toBe(2);

    const audit = fs.readFileSync(auditPath, "utf8");
    // The sync's writes name it; the test's own reveal above is the owner's, and says so.
    const writes = audit.split("\n").filter((line) => /-> (CREATED|UPDATED)$/.test(line));
    expect(writes).toHaveLength(2);
    expect(writes.every((line) => line.includes("page=ONEPASSWORD"))).toBe(true);
    expect(audit).not.toContain("rs-secret");
    expect(audit).not.toContain("lu-secret");
  });

  it("an excluded item (by id or by title, any case) is never fetched, so its values never leave 1Password", async () => {
    const { vault } = tempVault();
    const items = {
      mercury: opLogin("mercury", "Mercury", "bank-secret"),
      sam: opLogin("sam", "Sam's Reddit", "sam-secret"),
      luma: opLogin("luma", "Luma", "lu-secret"),
    };
    const calls: string[][] = [];
    const result = await syncFromOnePassword(vault, "Agents", fakeOp(items, calls), ["mercury", " sam's reddit "]);
    expect(result).toEqual(counts({ excluded: 2, saved: 1 }));
    expect(calls.filter((c) => c[1] === "get").map((c) => c[2])).toEqual(["luma"]);
    expect((await vault.list()).map((i) => i.title)).toEqual(["Luma"]);
  });

  it("a match that asks for the owner is left alone, never prompted for, and the rest still lands", async () => {
    const { vault, dir } = tempVault();
    await syncFromOnePassword(vault, "Agents", fakeOp({ bank: opLogin("bank", "Bank", "old-pw") }));
    const [held] = await vault.list();
    const store = new VaultStore(dir);
    store.upsert({ ...store.get(held!.id)!, reprompt: 1 }); // the owner marked it "ask me first"
    let asked = 0;
    vault.onReprompt = async () => (asked++, false);

    const items = { bank: opLogin("bank", "Bank", "rotated-pw"), luma: opLogin("luma", "Luma", "lu-secret") };
    const result = await syncFromOnePassword(vault, "Agents", fakeOp(items));
    expect(asked).toBe(0);
    expect(result).toEqual(counts({ saved: 1, skipped: 1 }));
    vault.onReprompt = async () => true;
    expect(await vault.reveal(held!.id, "password")).toBe("old-pw");
  });

  it("a password rotated in 1Password updates the same item, not a second one", async () => {
    const { vault } = tempVault();
    await syncFromOnePassword(vault, "Agents", fakeOp({ luma: opLogin("luma", "Luma", "old-pw") }));
    const result = await syncFromOnePassword(vault, "Agents", fakeOp({ luma: opLogin("luma", "Luma", "new-pw") }));
    expect(result).toEqual(counts({ updated: 1 }));
    const [only, ...rest] = await vault.list();
    expect(rest).toEqual([]);
    expect(await vault.reveal(only!.id, "password")).toBe("new-pw");
  });

  it("an item op will not hand over is reported by title, and the rest still land", async () => {
    const { vault } = tempVault();
    const items = { luma: opLogin("luma", "Luma", "lu-secret") };
    const op = fakeOp(items);
    const flaky: OpRunner = async (args) => (args[2] === "gone" ? Promise.reject(new Error("no")) : op(args));
    const listOnly: OpRunner = async (args) =>
      args[1] === "list" ? JSON.stringify([{ id: "gone", title: "Gone" }, { id: "luma", title: "Luma" }]) : flaky(args);
    const result = await syncFromOnePassword(vault, "Agents", listOnly);
    expect(result).toEqual(counts({ saved: 1, skipped: 1 }));
  });
});
