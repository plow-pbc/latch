/**
 * The built-in message-archive skill — what a remote agent reads before
 * querying this Mac's msgvault archive through the msgvault_* tools.
 */
import { Skill } from "../skills.js";

export const MSGVAULT_SKILL: Skill = {
  name: "msgvault-messages",
  description:
    "Search and read the owner's local message archive (iMessage and other imported " +
    "sources) on this Mac. Use for any task that needs something from the owner's " +
    "message history: finding a conversation, an address someone texted, a " +
    "confirmation code, what was agreed with a contact.",
  body: `# The message archive on this Mac

This Mac keeps a local, read-only searchable archive of the owner's messages
(imported iMessages today; other sources may be added). Three tools query it:

- \`plow_msgvault_search {query, limit?, offset?, account?, goal}\` — full-text search.
  Returns message summaries (sender, date, snippet, id).
- \`plow_msgvault_get_message {id, goal}\` — one full message by id (ids come from search).
- \`plow_msgvault_stats {goal}\` — what the archive holds (counts, sources, date range).

## Query syntax

\`plow_msgvault_search\` uses Gmail-like full-text syntax: bare words match message
text; \`from:someone\` filters by sender; quoted phrases match exactly; date
filters like \`after:2024-01-01\` / \`before:2024-12-31\` narrow the range.

## What to expect

- The first call after a while can be slow (the archive engine starts on
  demand). If a call returns a pending handle, poll \`plow_get_result\` with it.
- Results contain the owner's real private messages. Retrieve only what the
  goal needs, and never quote more of a conversation than the task requires.
- The owner approves archive access once per agent (or always-allows it); the
  approval covers reading only. Importing new messages is owner-only — there
  is no tool for it, so if the archive looks stale or empty, say so and ask
  the owner to run an import from the app's Settings → Capabilities section.
`,
};
