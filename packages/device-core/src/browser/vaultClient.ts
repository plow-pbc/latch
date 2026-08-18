/**
 * The vault, spoken to directly.
 *
 * The app already owns the account this machine's vault runs under, so it can
 * do what the command-line tool was doing for us: sign in once, hold the
 * account key in memory, and read or write items over the vault's own HTTPS
 * API. That removes a process start (~1.5s of Node, per click) from every
 * action, and with it the session key on disk and any local port — the only
 * thing holding a secret is the app that already has to be trusted.
 *
 * The CLI broker stays where it belongs: serving the AGENT, where a release is
 * bound to the page on screen and audited. This is the owner's own screen.
 */
import fs from "node:fs";
import path from "node:path";
import { httpCa, send, signIn, VaultHttp } from "./vaultCrypto.js";
import {
  Cipher,
  checkedUrls,
  decryptField,
  decryptItem,
  decryptSummary,
  encryptCipher,
  splitKey,
  TYPE_CODE,
  VaultItem,
  VaultItemInput,
  VaultItemSummary,
  VaultKey,
} from "./vaultItems.js";

/** What this client needs from the vault it belongs to. */
export interface OwnVault {
  readonly url: string;
  readonly certPath: string;
  readonly account: { email: string; password: string } | null;
  start(): Promise<void>;
}

export class VaultClient {
  private session: { http: VaultHttp; key: VaultKey } | null = null;

  /**
   * There is one vault on this Mac and this client is its owner-side face, so
   * it takes the server itself rather than a copy of its address, certificate,
   * account and startup. One fewer thing to keep in step.
   */
  constructor(
    private readonly server: OwnVault,
    /** One line per value the owner asked to see. Never the value. */
    private readonly auditPath?: string,
  ) {}

  /** Sign in once and keep the account key; the token is refreshed on refusal. */
  private async open(): Promise<{ http: VaultHttp; key: VaultKey }> {
    // Before the session, every time: a vault that exited since the last call
    // has to come back up, and a cached session would talk to a closed port.
    await this.server.start();
    if (this.session) return this.session;
    const account = this.server.account;
    if (!account) throw new Error("this machine has no vault account yet");
    const http: VaultHttp = { url: this.server.url, ca: httpCa(this.server.certPath) };
    const { userKey } = await signIn(http, account.email, account.password);
    this.session = { http, key: splitKey(userKey) };
    return this.session;
  }

  /** One request, signing in again if the token has gone stale. */
  private async call(method: string, urlPath: string, body?: string): Promise<string> {
    for (const attempt of [0, 1]) {
      const { http } = await this.open();
      const res = await send(http, method, urlPath, body);
      if (res.status === 401 && attempt === 0) {
        this.session = null; // expired token: sign in again, once
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`the vault refused that (HTTP ${res.status})`);
      }
      return res.body;
    }
    throw new Error("the vault would not accept this machine's account");
  }

  private async ciphers(): Promise<Cipher[]> {
    const body = await this.call("GET", "/api/ciphers");
    const parsed = JSON.parse(body) as { data?: Cipher[]; Data?: Cipher[] };
    return parsed.data ?? parsed.Data ?? [];
  }

  private async cipher(itemId: string): Promise<Cipher> {
    return JSON.parse(await this.call("GET", `/api/ciphers/${encodeURIComponent(itemId)}`)) as Cipher;
  }

  /** Everything in the vault, in the clear except the secrets themselves. */
  async list(): Promise<VaultItemSummary[]> {
    const { key } = await this.open();
    return (await this.ciphers()).map((c) => decryptSummary(c, key));
  }

  /** One whole item, with its secret values null — what a form is filled from. */
  async read(itemId: string): Promise<VaultItem> {
    const { key } = await this.open();
    return decryptItem(await this.cipher(itemId), key);
  }

  /**
   * One value, because the owner asked to see it on their own screen. There is
   * no page to bind it to, so the audit line says so rather than naming a site.
   */
  async reveal(itemId: string, field: string): Promise<string> {
    const { key } = await this.open();
    const value = decryptField(await this.cipher(itemId), key, field);
    this.audit(itemId, field, "SHOWN in app");
    return value;
  }

  /** Create an item, or change one that is already there. */
  async save(input: VaultItemInput): Promise<{ id: string; title: string }> {
    const { key } = await this.open();
    const existing = input.itemId ? await this.cipher(input.itemId) : null;
    const type = existing?.type ?? TYPE_CODE[input.type ?? "login"];
    // Only what the owner actually typed is checked. A new login needs a site;
    // an edit re-states the one URL it displayed, and the rest of the item's
    // URLs are never revalidated — they may hold match rules this screen does
    // not speak, and an edit to a username must not fail on one.
    if (type === 1) {
      if (!existing) input = { ...input, urls: checkedUrls(input.urls ?? []) };
      // Blank included: emptying the field would leave a login the fill path
      // can never match, which is the same item the check exists to refuse.
      else if (typeof input.url === "string") input = { ...input, url: checkedUrls([input.url])[0] };
    }
    if (!existing && !String(input.name ?? "").trim()) throw new Error("a new item needs a name");

    const cipher = encryptCipher(input, existing, key);
    const saved = JSON.parse(
      input.itemId
        ? await this.call("PUT", `/api/ciphers/${encodeURIComponent(input.itemId)}`, JSON.stringify(cipher))
        : await this.call("POST", "/api/ciphers", JSON.stringify(cipher)),
    ) as Cipher;
    this.audit(String(saved.id ?? ""), "(item)", input.itemId ? "UPDATED" : "CREATED");
    return { id: String(saved.id ?? ""), title: String(input.name ?? "") };
  }

  private audit(itemId: string, field: string, outcome: string): void {
    if (!this.auditPath) return;
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(
        this.auditPath,
        `${new Date().toISOString()}  item=${itemId}  field=${field}  page=OWNER  -> ${outcome}\n`,
      );
    } catch {
      /* an audit that cannot be written must not fail the owner's action */
    }
  }
}
