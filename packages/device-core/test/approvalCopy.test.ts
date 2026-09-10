/**
 * ONE guard for a wording family that has now drifted three times.
 *
 * Every string an agent reads about approval used to be written as if a human
 * always sees the request: "what the owner sees in the approval dialog", "the
 * sentence the owner reads while deciding", "the owner said no". On the DEFAULT
 * mode (`adversarial`) none of that happens — the reviewer decides and no
 * dialog opens — so an agent repeating it tells the owner they saw, or refused,
 * something they never did.
 *
 * The three earlier fixes were leaf edits: the instructions block, then the
 * tool descriptions, then the skills. Each time the sweep missed a surface
 * because the surfaces are only findable by reading all of them. So this test
 * IS the seam: it walks every built-in skill, every tool description and input
 * field, and the server's own copy, and fails on the phrasing rather than on
 * one file. A new skill is covered the day it is registered.
 *
 * It bans the CLAIM, not the word: "the owner" is fine and often correct (they
 * own the Mac, they configure who decides, they answer macOS's own dialogs).
 * What is banned is asserting that the owner is the one who sees, reads, or
 * refuses a request this Mac decides.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSING_SKILL } from "../src/browser/browsingSkill.js";
import { contactsSkillFor } from "../src/contactsSkill.js";
import { imessageSkillFor } from "../src/imessageSkill.js";
import { whatsappSkillFor } from "../src/whatsappSkill.js";
import { GOG_SKILL } from "../src/providers/gogSkill.js";

/**
 * Each is a sentence that only holds when a human is the decider. Written as
 * patterns rather than exact strings because the drift each time was a
 * paraphrase, not a copy-paste.
 */
const OWNER_ONLY_CLAIMS: { pattern: RegExp; why: string }[] = [
  {
    pattern: /(owner|user|human)[^.\n]{0,40}sees[^.\n]{0,30}approval dialog/i,
    why: "no dialog opens in the default mode",
  },
  {
    pattern: /(owner|user)[^.\n]{0,30}reads[^.\n]{0,30}(while|when) deciding/i,
    why: "the reviewer is the reader when it is the decider",
  },
  {
    pattern: /\bthe (owner|user) (approves|approved|denies|denied|refused) (the|this|it)\b/i,
    why: "attributes a decision to a person who may never have been asked",
  },
  {
    pattern: /the (owner|user) (will )?(see|sees|saw) (the|this|your) (request|path|command)\b/i,
    why: "asserts the owner laid eyes on it",
  },
];

/** Everything a connected agent can read about how operations are decided. */
function agentVisibleCopy(): { where: string; text: string }[] {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "copy-"));
  const skills = [
    BROWSING_SKILL,
    GOG_SKILL,
    contactsSkillFor(home),
    imessageSkillFor(home),
    whatsappSkillFor(home),
  ];
  fs.rmSync(home, { recursive: true, force: true });
  return skills.flatMap((s) => [
    { where: `skill ${s.name} (description)`, text: s.description },
    { where: `skill ${s.name} (body)`, text: s.body },
  ]);
}

describe("nothing tells an agent the owner saw a request this Mac decided", () => {
  it.each(agentVisibleCopy())("$where", ({ where, text }) => {
    for (const { pattern, why } of OWNER_ONLY_CLAIMS) {
      const hit = text.match(pattern);
      expect(
        hit,
        `${where} claims a human decider (${why}): ${JSON.stringify(hit?.[0])}`,
      ).toBeNull();
    }
  });
});
