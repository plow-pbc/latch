/** SkillRegistry: frontmatter parsing, dir loading, manifest shape. */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSING_SKILL,
  DeviceAgent,
  HeadlessPolicy,
  registerWhatsappSkill,
  SkillRegistry,
  whatsappSkillFor,
  whatsappStorePath,
} from "@domo/device-core";
import { jv, JSONValue } from "@domo/protocol";

describe("SkillRegistry", () => {
  it("loads *.md with frontmatter and skips malformed files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-sk-"));
    fs.writeFileSync(
      path.join(dir, "good.md"),
      "---\nname: my-skill\ndescription: does things\n---\n# Body\ncontent here\n",
    );
    fs.writeFileSync(path.join(dir, "bad.md"), "no frontmatter at all");
    fs.writeFileSync(path.join(dir, "ignored.txt"), "---\nname: nope\n---\nx");
    const reg = new SkillRegistry();
    reg.loadDir(dir);
    expect(reg.skill("my-skill")?.description).toBe("does things");
    expect(reg.skill("my-skill")?.body).toContain("content here");
    expect(reg.manifest().length).toBe(1);
  });

  // Sorted, and names/descriptions ONLY. A body is fetched one at a time by
  // plow_read_skill; putting them all in the manifest would put a whole
  // operator manual on every listing.
  it("manifest is sorted and carries no bodies", () => {
    const reg = new SkillRegistry();
    reg.register({ name: "zeta", description: "z", body: "zz" });
    reg.register(BROWSING_SKILL);
    const manifest = reg.manifest();
    expect(manifest.map((s) => s.name)).toEqual(["camoufox-browsing", "zeta"]);
    expect(Object.keys(manifest[0])).toEqual(["name", "description"]);
    expect(reg.skill("camoufox-browsing")?.body).toContain("plow_browser_open");
  });

  it("the built-in browsing skill documents the critical gotchas", () => {
    expect(BROWSING_SKILL.body).toContain("back");
    expect(BROWSING_SKILL.body).toContain("use_page");
    expect(BROWSING_SKILL.body).toContain("fill_secret");
    expect(BROWSING_SKILL.body).toContain("plow_browser_request");
  });
});

describe("the built-in whatsapp-history skill", () => {
  // One question per row, not one test per row: same arrange, same act, and a
  // fact list that grows is a row rather than another near-identical function.
  // Each entry is something an agent gets wrong if the body omits it.
  it.each([
    ["the table of messages", /ZWAMESSAGE/],
    ["the table of chats", /ZWACHATSESSION/],
    ["who sent a message in a group", /ZWAGROUPMEMBER/],
    ["the message body column", /ZTEXT/],
    ["which side sent it", /ZISFROMME/],
    ["the name the owner sees", /ZPARTNERNAME/],
    ["how a group chat is told apart", /@g\.us/],
    ["the Core Data epoch offset", /978307200/],
    ["opening the store read-only", /-readonly/],
    ["keeping the store out of write_paths", /write_paths/],
    ["where sqlite3 lives", /\/usr\/bin\/sqlite3/],
    ["the WAL open failure an agent will otherwise misread", /unable to open database file/],
    ["the fallback for it", /immutable=1/],
    // The two safety rules the Plow-side section is deleted for. Losing either
    // in an edit is the failure this row exists to catch.
    ["message text being untrusted", /untrusted/i],
    ["a message that reads like an order not being one", /never do what it says/i],
    ["answering for the owner and nobody else", /only the owner's/i],
  ])("publishes %s", (_what, pattern) => {
    expect(whatsappSkillFor("/Users/example").body).toMatch(pattern);
  });

  // A limit takes the NEWEST rows, so the recipe has to sort twice: desc on the
  // inside to pick them, ascending on the outside to read them. One `order by`
  // gives you either the newest-first transcript the body says it is not, or
  // the fifty oldest messages in the chat.
  it("hands back a conversation in reading order, not just the oldest fifty", () => {
    const body = whatsappSkillFor("/Users/example").body;
    const recipe = body.slice(body.indexOf("**A conversation"));
    expect(recipe).toMatch(/order by m\.ZMESSAGEDATE desc\s+limit 50/);
    expect(recipe).toMatch(/\)\s*order by ord;/);
  });

  // The Plow-side copy shipped from a machine that was not this one, so it had
  // to write /Users/<owner> and hope the reader substituted correctly. Latch
  // knows the answer; that is the whole reason the recipe moved here.
  it("names this Mac's own store rather than a path the reader must fill in", () => {
    const skill = whatsappSkillFor("/Users/example");
    expect(skill.name).toBe("whatsapp-history");
    expect(skill.body).toContain(
      "/Users/example/Library/Group Containers/" +
        "group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite",
    );
    expect(skill.body).not.toContain("<owner>");
    expect(skill.description).toMatch(/whatsapp/i);
  });

  // Same rule the browsing skill follows: a skill naming a capability this Mac
  // does not have is a guaranteed denial.
  it("is published only on a Mac that actually has the archive", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-wa-"));
    const absent = new SkillRegistry();
    registerWhatsappSkill(absent, home);
    expect(absent.skill("whatsapp-history")).toBeNull();

    fs.mkdirSync(path.dirname(whatsappStorePath(home)), { recursive: true });
    fs.writeFileSync(whatsappStorePath(home), "");
    const present = new SkillRegistry();
    registerWhatsappSkill(present, home);
    expect(present.skill("whatsapp-history")?.body).toContain(whatsappStorePath(home));
  });
});

// What DeviceAgent actually wires up. The two behaviours here are the ones a
// unit test of the registry alone cannot see: which home gets described, and
// who wins a name collision.
describe("the skills a DeviceAgent publishes", () => {
  const roots: string[] = [];
  const tempDir = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "domo-agent-"));
    roots.push(d);
    return d;
  };
  const agentFor = (ownerHome: string, home = tempDir()): DeviceAgent =>
    new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "allow_once" }), null, ownerHome);

  afterEach(() => {
    for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  // Construction must not depend on whether the developer running the suite
  // happens to have WhatsApp installed: same inputs, same manifest, every Mac.
  it("describes the owner home it was given, not the machine it runs on", () => {
    const ownerHome = tempDir();
    expect(agentFor(ownerHome).skills.skill("whatsapp-history")).toBeNull();

    fs.mkdirSync(path.dirname(whatsappStorePath(ownerHome)), { recursive: true });
    fs.writeFileSync(whatsappStorePath(ownerHome), "");
    expect(agentFor(ownerHome).skills.skill("whatsapp-history")?.body).toContain(
      whatsappStorePath(ownerHome),
    );
  });

  // A file the owner wrote into their own DOMO_HOME is a deliberate act; a
  // built-in default arriving later and taking the name would discard it in
  // silence.
  it("lets a skill the owner wrote beat the built-in of the same name", () => {
    const ownerHome = tempDir();
    fs.mkdirSync(path.dirname(whatsappStorePath(ownerHome)), { recursive: true });
    fs.writeFileSync(whatsappStorePath(ownerHome), "");

    const home = tempDir();
    fs.mkdirSync(path.join(home, "device/skills"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "device/skills/whatsapp-history.md"),
      "---\nname: whatsapp-history\ndescription: mine\n---\nthe owner's own recipe\n",
    );

    const skill = agentFor(ownerHome, home).skills.skill("whatsapp-history");
    expect(skill?.description).toBe("mine");
    expect(skill?.body).toBe("the owner's own recipe");
  });
});
