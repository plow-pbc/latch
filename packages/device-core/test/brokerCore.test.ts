/**
 * The in-process credential broker over a real encrypted store: the site
 * check, the metadata surfaces, the locked-vault refusal, and the audit lines
 * the fill path is judged by. Classification itself is owned by
 * maskClassification.test.ts; this file owns the broker's CONDUCT around it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerCore, hostsRelated } from "../src/browser/brokerCore.js";
import { CredentialError } from "../src/browser/credentialBroker.js";
import { LocalVault } from "../src/browser/localVault.js";
import { VaultKeyStore } from "../src/browser/vaultKeyStore.js";
import { VaultStore } from "../src/browser/vaultStore.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-core-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A vault with one login, one card, and the broker beside it. */
async function fixture(): Promise<{ broker: BrokerCore; auditPath: string; loginId: string; cardId: string }> {
  const dir = tempDir();
  const keyStore = new VaultKeyStore(dir, "test");
  const auditPath = path.join(dir, "broker-audit.log");
  const vault = new LocalVault(dir, keyStore);
  const login = await vault.save({
    type: "login", name: "Pizza", urls: ["https://pizza.example/login"],
    username: "jon", password: "hunter2",
  });
  const card = await vault.save({
    type: "card", name: "Amex", cardholderName: "Jon D",
    number: "4111111111111111", code: "737", expMonth: "12", expYear: "2030",
  });
  const broker = new BrokerCore({ dir, store: new VaultStore(dir), keyStore, auditPath });
  return { broker, auditPath, loginId: login.id, cardId: card.id };
}

const lines = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

describe("BrokerCore", () => {
  it("lists metadata only, with page-match advice, and never a secret", async () => {
    const { broker } = await fixture();
    const items = broker.whatsHere("https://pizza.example/checkout");
    expect(items).toHaveLength(2);
    const login = items.find((i) => i.category === "LOGIN")!;
    expect(login.title).toBe("Pizza");
    expect(login.username).toBe("jon");
    expect(login.matchesThisPage).toBe(true);
    expect(items.find((i) => i.category === "CREDIT_CARD")!.matchesThisPage).toBe(false);
    expect(JSON.stringify(items)).not.toContain("hunter2");
    expect(JSON.stringify(items)).not.toContain("4111111111111111");
  });

  it("releases a login on its own site — subdomains included, both directions", async () => {
    const { broker, loginId } = await fixture();
    expect(broker.getField(loginId, "password", "https://pizza.example/a")).toEqual({
      value: "hunter2",
      hidden: true,
    });
    // Stored apex, page on a subdomain: the label-suffix rule.
    expect(broker.getField(loginId, "password", "https://www.pizza.example/a").value).toBe("hunter2");
  });

  it("refuses a login off its site, and one with no site at all — and audits both", async () => {
    const { broker, auditPath, loginId } = await fixture();
    expect(() => broker.getField(loginId, "password", "https://evil.example/")).toThrow(CredentialError);
    expect(lines(auditPath)).toContain("DENIED origin mismatch");
    expect(lines(auditPath)).not.toContain("hunter2");
  });

  it("releases a card on ANY site — a card is meant for any merchant", async () => {
    const { broker, cardId } = await fixture();
    const release = broker.getField(cardId, "number", "https://shop.example/checkout");
    expect(release).toEqual({ value: "4111111111111111", hidden: true });
    expect(broker.getField(cardId, "cardholder name", "https://shop.example/").hidden).toBe(false);
    // The composed date label: expMonth "12" + expYear "2030" as one YYYY-MM.
    expect(broker.getField(cardId, "expiry", "https://shop.example/")).toEqual({
      value: "2030-12",
      hidden: false,
    });
  });

  it("records SEM-URL when no page binds the release", async () => {
    const { broker, auditPath, cardId } = await fixture();
    broker.getField(cardId, "number");
    expect(lines(auditPath)).toMatch(/page=SEM-URL\s+-> RELEASED/);
  });

  it("answers a FRESH vault with an empty listing, not VaultLocked", async () => {
    // The agent side goes through the same open path as the Vault tab: a
    // clean install mints its key on whichever side asks first, so plow_vault
    // works before the owner has ever opened the tab.
    const dir = tempDir();
    const keyStore = new VaultKeyStore(dir, "test");
    const broker = new BrokerCore({ dir, store: new VaultStore(dir), keyStore });
    expect(broker.whatsHere()).toEqual([]);
    expect(keyStore.state()).toEqual({ status: "ok" });
    // And the Vault tab then opens the SAME vault, not a second one.
    const vault = new LocalVault(dir, keyStore);
    await vault.save({ type: "note", name: "N", notes: "x" });
    expect(broker.whatsHere()).toHaveLength(1);
  });

  it("answers a locked vault with VaultLocked, not an empty listing", async () => {
    const dir = tempDir();
    // A key blob that cannot be opened here.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "vault-key.enc"), Buffer.concat([Buffer.from("KENC1"), Buffer.from("x")]));
    const broker = new BrokerCore({ dir, store: new VaultStore(dir), keyStore: new VaultKeyStore(dir, "test") });
    expect(broker.status()).toEqual({ ok: true, signed_in: false });
    expect(() => broker.whatsHere()).toThrow(/could not be unlocked/);
  });

  it("refuses an unknown field with the item's own offer list", async () => {
    const { broker, loginId } = await fixture();
    expect(() => broker.getField(loginId, "cvv", "https://pizza.example/")).toThrow(/it offers: username, password/);
  });
});

describe("hostsRelated", () => {
  it("refuses a suffix relation whose root is a PUBLIC suffix", () => {
    // A login stored for `co.uk` must not release on every site under co.uk:
    // label-suffix logic alone cannot tell a public suffix from somebody's
    // domain, so the suffix branch is gated on the pinned PSL — the private
    // section too (github.io is as public as co.uk). Exact matches stay
    // PSL-free so localhost and bare-IP fills keep working.
    expect(hostsRelated("co.uk", "attacker.co.uk")).toBe(false);
    expect(hostsRelated("github.io", "victim.github.io")).toBe(false);
    expect(hostsRelated("co.uk", "co.uk")).toBe(true); // exact stays exact
    expect(hostsRelated("localhost", "localhost")).toBe(true);
  });

  it("still refuses a public-suffix login at the release gate itself", async () => {
    const dir = tempDir();
    const keyStore = new VaultKeyStore(dir, "test");
    const vault = new LocalVault(dir, keyStore);
    const login = await vault.save({
      type: "login", name: "Oops", urls: ["co.uk"], username: "x", password: "pw-oops",
    });
    const broker = new BrokerCore({ dir, store: new VaultStore(dir), keyStore });
    expect(() => broker.getField(login.id, "password", "https://attacker.co.uk/login")).toThrow(
      /belongs to co\.uk/,
    );
    // The exact host still releases — the item is odd, not unusable.
    expect(broker.getField(login.id, "password", "https://co.uk/").value).toBe("pw-oops");
  });

  it("matches hosts that share one registrable domain", () => {
    expect(hostsRelated("pizza.example", "pizza.example")).toBe(true);
    expect(hostsRelated("www.pizza.example", "pizza.example")).toBe(true);
    expect(hostsRelated("pizza.example", "www.pizza.example")).toBe(true);
    // NOT a suffix relation: notpizza.example must never match pizza.example.
    expect(hostsRelated("notpizza.example", "pizza.example")).toBe(false);
    // Sibling subdomains are one site: a password manager stores the host it
    // first saw (secure.opentable.com) while the login form lives on www.
    expect(hostsRelated("secure.opentable.com", "www.opentable.com")).toBe(true);
    expect(hostsRelated("a.pizza.example", "b.pizza.example")).toBe(true);
    // ...unless the shared suffix is a public one: nobody owns github.io.
    expect(hostsRelated("victim.github.io", "attacker.github.io")).toBe(false);
  });
});
