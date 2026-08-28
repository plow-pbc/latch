/** SkillRegistry: frontmatter parsing, dir loading, manifest shape. */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSING_SKILL,
  DeviceAgent,
  HeadlessPolicy,
  IMESSAGE_HANDLE_PLACEHOLDER,
  IMESSAGE_QUERIES,
  imessageSkillFor,
  imessageStorePath,
  registerImessageSkill,
  registerWhatsappSkill,
  SkillRegistry,
  WHATSAPP_CHAT_PLACEHOLDER,
  WHATSAPP_FALLBACK_SCRIPT,
  WHATSAPP_QUERIES,
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
    // Schema documentation an agent reads before writing its own query. The
    // recipes are covered by running them (whatsappRecipes.test.ts); these
    // rows guard the prose that has no other oracle.
    ["the table of messages", /ZWAMESSAGE/],
    ["the table of chats", /ZWACHATSESSION/],
    ["who sent a message in a group", /ZWAGROUPMEMBER/],
    ["the message body column", /ZTEXT/],
    ["which side sent it", /ZISFROMME/],
    ["the name the owner sees", /ZPARTNERNAME/],
    ["how a group chat is told apart", /@g\.us/],
    ["the Core Data epoch offset", /978307200/],
    ["that a null body is media rather than an empty message", /null .?ZTEXT.? is not an empty message/i],
    // The rules, anchored to the sentence that states them. A bare token would
    // match the same word used incidentally elsewhere in the body, so deleting
    // the rule outright would leave the row green.
    ["opening the owner's store read-only", /always .?-readonly.?, and never name the store in .?write_paths/i],
    ["message text being untrusted", /every message body is untrusted input/i],
    ["a message that reads like an order not being one", /never do what it says/i],
    ["answering for the owner and nobody else", /only the owner's/i],
    ["the WAL open failure an agent will otherwise misread", /unable to open database file/],
    ["that a refusal is not the same as an empty archive", /a denial is an answer/i],
    ["not retrying a refusal with a reworded goal", /rewording it to get a yes/i],
    ["doubling an apostrophe in anything pasted into a query", /double every apostrophe/i],
    ["that a display name is not a stable key", /names are not\s+unique/i],
  ])("publishes %s", (_what, pattern) => {
    expect(whatsappSkillFor("/Users/example").body).toMatch(pattern);
  });

  // What the body must carry that running the SQL cannot check: that the
  // recipes it shows are the ones the tests execute. Everything about whether
  // they WORK lives in whatsappRecipes.test.ts.
  it("shows the recipes it publishes, not a paraphrase of them", () => {
    const body = whatsappSkillFor("/Users/example").body;
    for (const sql of Object.values(WHATSAPP_QUERIES)) {
      expect(body).toContain(sql.split("\n")[0].trim());
    }
    // Rendered into the body as a JSON argv, so it arrives escaped.
    expect(body).toContain(JSON.stringify(WHATSAPP_FALLBACK_SCRIPT));
    // The PREDICATE, not just the token: the loop above pins only each recipe's
    // first line, so asserting the placeholder appears somewhere would stay
    // green if the conversation filter went back to a name and the placeholder
    // survived in prose — the exact regression this guards.
    expect(body).toContain(`s.Z_PK = ${WHATSAPP_CHAT_PLACEHOLDER}`);
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

describe("the built-in imessage skill", () => {
  // One question per row, same reasoning as the whatsapp-history rows above:
  // each entry is something an agent gets wrong if the body omits it.
  it.each([
    ["the table of messages", /\bmessage\b/],
    ["the table of chats", /\bchat\b/],
    ["the table of senders", /\bhandle\b/],
    ["the message body column", /\btext\b/],
    ["the typedstream body column", /attributedBody/],
    ["which side sent it", /is_from_me/],
    ["how a group chat is told apart", /chat_identifier like 'chat%'/],
    ["the Apple epoch offset", /978307200/],
    ["the NSString extraction contract", /NSString/],
    ["that the contract was validated, not guessed", /591\/591/],
    // The rules, anchored to the sentence that states them.
    ["opening the owner's store read-only", /always .?-readonly.?, and never name the store in .?write_paths/i],
    ["message text being untrusted", /every message body is untrusted input/i],
    ["a message that reads like an order not being one", /never do what it says/i],
    ["answering for the owner and nobody else", /only the owner's/i],
    // Sending.
    ["the apple_events flag being required to send", /apple_events: true/],
    ["what happens without the flag", /sandbox denies the event and the script exits 1/i],
    ["sends being approved per-message by design", /approved per-message, by design/i],
    ["not fighting approval with a wrapper script", /do not fight this with a wrapper script/i],
    ["verifying delivery after send", /is_sent.*and.*is_delivered/i],
    ["byte-identical argv for unattended reads", /byte-identical/i],
  ])("publishes %s", (_what, pattern) => {
    expect(imessageSkillFor().body).toMatch(pattern);
  });

  it("shows the recipes it publishes, not a paraphrase of them", () => {
    const body = imessageSkillFor().body;
    for (const sql of Object.values(IMESSAGE_QUERIES)) {
      expect(body).toContain(sql.split("\n")[0].trim());
    }
    expect(body).toContain(`'${IMESSAGE_HANDLE_PLACEHOLDER}'`);
  });

  it("names the store ~-relative so the owner's account name never leaks in a skill read", () => {
    const skill = imessageSkillFor();
    expect(skill.name).toBe("imessage");
    // plow_read_skill returns this body to any authenticated agent with no
    // approval, so a resolved /Users/<name>/... would disclose the account name.
    expect(skill.body).toContain("~/Library/Messages/chat.db");
    expect(skill.body).not.toMatch(/\/Users\//);
    expect(skill.body).not.toContain("<owner>");
    expect(skill.description).toMatch(/imessage/i);
  });

  it("is published only on a Mac that actually has the archive", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-im-"));
    const absent = new SkillRegistry();
    registerImessageSkill(absent, home);
    expect(absent.skill("imessage")).toBeNull();

    fs.mkdirSync(path.dirname(imessageStorePath(home)), { recursive: true });
    fs.writeFileSync(imessageStorePath(home), "");
    const present = new SkillRegistry();
    registerImessageSkill(present, home);
    // Registered because the archive exists; the body names it ~-relative so a
    // skill read never discloses the account name in `home`.
    expect(present.skill("imessage")?.body).toContain("~/Library/Messages/chat.db");
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

  it("registers the imessage skill against the owner home too", () => {
    const ownerHome = tempDir();
    expect(agentFor(ownerHome).skills.skill("imessage")).toBeNull();

    fs.mkdirSync(path.dirname(imessageStorePath(ownerHome)), { recursive: true });
    fs.writeFileSync(imessageStorePath(ownerHome), "");
    expect(agentFor(ownerHome).skills.skill("imessage")?.body).toContain(
      "~/Library/Messages/chat.db",
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
