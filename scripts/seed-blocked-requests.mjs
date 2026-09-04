// Seed the audit log with sample blocked requests, so the Capabilities tab
// (and the Audit tab's Blocked filter) can be looked at without revoking
// anything first. The rows have the same shape DeviceAgent writes — an
// intent_received / intent_decision pair, the run's exec_start/exec_end
// where there was a run, and the host_permission_blocked line with its
// diagnosis — spread over the last eight hours, so the banner, the counts,
// the "last …" times and the per-switch grouping all have something to show.
//
// The banner only counts blocks after its last dismissal, and a tester who
// dismissed it a minute ago wants the seeded rows to count as new. So when
// a settings.json is given and it records a dismissal inside the window,
// the rows are packed into the time since it instead (same order, same
// spacing) — and "Show in Audit" then narrows the Audit tab to exactly them.
//
// Fake by construction: the agents are named after nobody, the goals are
// made up, and every line carries `seeded: true` so it can be told from a
// real block (and removed: `just unseed-blocked-requests`).
//
// Usage: node scripts/seed-blocked-requests.mjs <audit.ndjson> [settings.json] [--remove]
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2).filter((a) => a !== "--remove");
const file = args[0];
const settingsFile = args[1] ?? null;
if (!file) {
  console.error("usage: seed-blocked-requests.mjs <audit.ndjson> [settings.json] [--remove]");
  process.exit(2);
}
const remove = process.argv.includes("--remove");

if (remove) {
  if (!fs.existsSync(file)) process.exit(0);
  const kept = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0 && !/"seeded":true/.test(line));
  fs.writeFileSync(file, kept.map((l) => l + "\n").join(""));
  console.log(`removed the seeded rows from ${file}`);
  process.exit(0);
}

const now = Date.now();
const WINDOW_H = 8;
// The window the rows are spread over: the last eight hours, or the time
// since the banner's dismissal when that is more recent (never less than a
// minute, so the rows keep an order).
let windowMs = WINDOW_H * 3_600_000;
if (settingsFile && fs.existsSync(settingsFile)) {
  try {
    const seenAt = JSON.parse(fs.readFileSync(settingsFile, "utf8")).blockedBannerSeenAt;
    const sinceSeen = seenAt ? now - new Date(seenAt).getTime() : NaN;
    if (Number.isFinite(sinceSeen) && sinceSeen < windowMs) {
      windowMs = Math.max(sinceSeen, 60_000);
      console.log(`the banner was dismissed ${Math.round(sinceSeen / 60_000)} minutes ago; the rows land after that`);
    }
  } catch {
    /* an unreadable settings.json means no dismissal to honour */
  }
}
// "h hours ago" on an eight-hour scale, mapped onto the window.
const hoursAgo = (h) => new Date(now - (h / WINDOW_H) * windowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
let n = 0;
const id = () => `seed-${Date.now().toString(36)}-${(n += 1)}`;

const FDA_ACTION =
  "In System Settings > Privacy & Security > Full Disk Access, turn on Plow Latch, then quit and reopen it.";
const FOLDER_ACTION = (label) =>
  `In System Settings > Privacy & Security > ${label}, allow Plow Latch. Granting Plow Latch Full Disk Access instead covers this and every other folder at once.`;
const PROMPT_ACTION =
  "A macOS permission dialog is open on the Mac's screen and only the owner, at the Mac, can answer it. Until they click Allow this stays blocked; if they click Don't Allow it will fail the same way next time until they change it in System Settings > Privacy & Security.";
const AUTOMATION_ACTION = (app) =>
  `In System Settings > Privacy & Security > Automation, allow Plow Latch to control ${app}.`;

/** One blocked request: the intent pair, a run if there was one, the block. */
function blocked({ at, agent, agentName, request, goal, argv, exitCode, permission, cause, confidence, path: p, ownerAction, target }) {
  const intentId = id();
  const rows = [
    { event: "intent_received", intentId, agent, agent_name: agentName, request, goal, capabilities: argv ? [`Run: ${argv.join(" ")}`] : [`Read: ${p}`], ts: at },
    { event: "intent_decision", intentId, decision: "allow_once", source: "adversarial", ts: at },
  ];
  if (argv) {
    rows.push({ event: "exec_start", intentId, argv, ts: at });
    rows.push({ event: "exec_end", intentId, exit_code: exitCode ?? 1, ts: at });
  }
  rows.push({
    event: "host_permission_blocked",
    intentId,
    ...(argv ? { handle: id().toUpperCase() } : {}),
    path: p,
    cause,
    confidence,
    permission,
    evidence: [`the kernel answered EPERM for ${p}`],
    ruled_out: ["file missing", "sandbox bound"],
    owner_action: ownerAction,
    probes: {
      op: argv ? "exec" : "read",
      path: p,
      errno: "EPERM",
      app_process_open: cause === "prompt_waiting" ? "hung" : "EPERM",
      hung: cause === "prompt_waiting",
      tcc_guarded_prefix: permission === "automation" ? null : permission,
      full_disk_access_granted: false,
      automation_target: target ?? null,
      automation_status: target ? "denied" : null,
    },
    ts: at,
  });
  return rows.map((r) => ({ ...r, seeded: true }));
}

const family = { agent: "seed-agent-family", agentName: "Family Coordinator" };
const inbox = { agent: "seed-agent-inbox", agentName: "Inbox Triage" };
const chat = "~/Library/Messages/chat.db";

const rows = [
  ...blocked({ ...family, at: hoursAgo(7.8), request: "run: sqlite3 -readonly ~/Library/Messages/chat.db …", goal: "check whether Sam replied about Saturday", argv: ["/usr/bin/sqlite3", "-readonly", chat, "select 1"], permission: "full_disk_access", cause: "macos_permission", confidence: "confirmed", path: chat, ownerAction: FDA_ACTION }),
  ...blocked({ ...inbox, at: hoursAgo(6.0), request: "run: mdfind -onlyin ~/Library/Mail …", goal: "find the Delta receipt in Mail for the expense report", argv: ["/usr/bin/mdfind", "-onlyin", "~/Library/Mail", "Delta"], permission: "full_disk_access", cause: "macos_permission", confidence: "confirmed", path: "~/Library/Mail", ownerAction: FDA_ACTION }),
  ...blocked({ ...inbox, at: hoursAgo(5.98), request: "run: mdfind -onlyin ~/Library/Mail …", goal: "find the Delta receipt in Mail for the expense report", argv: ["/usr/bin/mdfind", "-onlyin", "~/Library/Mail", "Delta"], permission: "full_disk_access", cause: "macos_permission", confidence: "confirmed", path: "~/Library/Mail", ownerAction: FDA_ACTION }),
  ...blocked({ ...family, at: hoursAgo(4.5), request: "run: osascript -e 'tell application \"Messages\" …'", goal: "text Sam that Saturday works", argv: ["/usr/bin/osascript", "-e", 'tell application "Messages" to send "Saturday works" to buddy "Sam"'], permission: "automation", cause: "macos_permission", confidence: "confirmed", path: null, ownerAction: AUTOMATION_ACTION("Messages"), target: "Messages" }),
  ...blocked({ ...family, at: hoursAgo(3.2), request: "read file: ~/Downloads/lease.pdf", goal: "read the lease Sam sent so I can summarise it", permission: "files_downloads", cause: "macos_permission", confidence: "confirmed", path: "~/Downloads/lease.pdf", ownerAction: FOLDER_ACTION("Files and Folders > Downloads Folder") }),
  ...blocked({ ...inbox, at: hoursAgo(2.1), request: "read file: ~/Desktop/notes.txt", goal: "pull the action items out of today's notes", permission: "files_desktop", cause: "prompt_waiting", confidence: "confirmed", path: "~/Desktop/notes.txt", ownerAction: PROMPT_ACTION }),
  ...blocked({ ...inbox, at: hoursAgo(1.4), request: "run: screencapture -x /tmp/shot.png", goal: "grab a screenshot of the error the user described", argv: ["/usr/sbin/screencapture", "-x", "/tmp/shot.png"], permission: "screen_recording", cause: "macos_permission", confidence: "likely", path: "/tmp/shot.png", ownerAction: "In System Settings > Privacy & Security > Screen & System Audio Recording, allow Plow Latch." }),
  ...blocked({ ...family, at: hoursAgo(0.7), request: "run: sqlite3 -readonly ~/Library/Messages/chat.db …", goal: "read the code Chase just texted so I can finish the login", argv: ["/usr/bin/sqlite3", "-readonly", chat, "select 1"], permission: "full_disk_access", cause: "macos_permission", confidence: "confirmed", path: chat, ownerAction: FDA_ACTION }),
  ...blocked({ ...family, at: hoursAgo(0.68), request: "run: sqlite3 -readonly ~/Library/Messages/chat.db …", goal: "read the code Chase just texted so I can finish the login", argv: ["/usr/bin/sqlite3", "-readonly", chat, "select 1"], permission: "full_disk_access", cause: "macos_permission", confidence: "confirmed", path: chat, ownerAction: FDA_ACTION }),
];

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.appendFileSync(file, rows.map((r) => JSON.stringify(r) + "\n").join(""));
const blocks = rows.filter((r) => r.event === "host_permission_blocked").length;
console.log(`appended ${rows.length} rows (${blocks} blocked requests) to ${file}`);
console.log("Open the Capabilities tab (or refocus the app) to see them; `just unseed-blocked-requests` removes them.");
