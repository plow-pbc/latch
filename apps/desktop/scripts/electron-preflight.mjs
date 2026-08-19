// Is this checkout able to launch Electron at all, and is there a build for it
// to launch?
//
// Written because the failure it catches is indistinguishable from a pass. A
// half-extracted Electron SIGABRTs at launch; a missing `path.txt` makes `npx
// electron` spawn a path that does not exist; an unbuilt `dist/` gives a window
// with no preload. All three produce a process that exits without saying
// anything useful, and a verification run whose output never appeared reads
// exactly like a verification run that passed.
//
// Runs under plain node, BEFORE Electron is asked to start, so it can still
// print when Electron is the thing that is broken.
//
//   node apps/desktop/scripts/electron-preflight.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(dir, "../../..");
const dist = path.resolve(dir, "../dist");
const electronDir = path.join(repo, "node_modules/electron");

/** Files a driver needs, and what is missing without them. */
const BUILT = [
  ["preload.cjs", "the sandboxed bridge every window loads"],
  ["renderer/approval.html", "the approval window itself"],
  ["renderer/approval.js", "its renderer"],
  ["renderer/continuationView.js", "the continuation copy the renderer imports"],
  ["approvalWindow.js", "the window lifecycle the drivers exercise"],
  ["relayWiring.js", "the relay callbacks the verification drives"],
];

/**
 * What is wrong, in the order a person would fix it. Empty means ready.
 *
 * The Electron repair is the one from the M4 procedure: npm >= 11 blocks
 * postinstall scripts, so the real binary never downloads, and running
 * `install.js` by hand can exit 0 after a partial extract. `path.txt` — not the
 * binary — is the honest guard, because a re-install leaves a stale `dist/`
 * behind but deletes `path.txt`.
 */
export function preflight() {
  const problems = [];

  if (!fs.existsSync(electronDir)) {
    problems.push({
      what: "Electron is not installed in this checkout.",
      fix: "just install",
    });
  } else {
    const pathTxt = path.join(electronDir, "path.txt");
    if (!fs.existsSync(pathTxt)) {
      problems.push({
        what: "node_modules/electron/path.txt is missing — the binary never finished installing.",
        fix: repairSteps(),
      });
    } else {
      const relative = fs.readFileSync(pathTxt, "utf8");
      if (relative !== relative.trim()) {
        problems.push({
          what: "node_modules/electron/path.txt has a trailing newline; Electron 33 does not trim it.",
          fix: `printf "Electron.app/Contents/MacOS/Electron" > ${pathTxt}`,
        });
      }
      const binary = path.join(electronDir, "dist", relative.trim());
      if (!fs.existsSync(binary)) {
        problems.push({
          what: `Electron's binary is not where path.txt says (${binary}).`,
          fix: repairSteps(),
        });
      }
    }
  }

  const missing = BUILT.filter(([file]) => !fs.existsSync(path.join(dist, file)));
  if (missing.length > 0) {
    problems.push({
      what:
        "The desktop build is missing:\n" +
        missing.map(([file, why]) => `    dist/${file} — ${why}`).join("\n"),
      fix: "just build   (and if you rsynced this tree, check *.tsbuildinfo was excluded)",
    });
  }

  return { ok: problems.length === 0, problems, dist, electronDir };
}

function repairSteps() {
  return [
    "cd node_modules/electron",
    'ver=$(node -p \'require("./package.json").version\')',
    "rm -rf dist && mkdir dist",
    'ditto -x -k ~/Library/Caches/electron/*/electron-v${ver}-darwin-arm64.zip dist',
    'printf "Electron.app/Contents/MacOS/Electron" > path.txt',
  ].join("\n    ");
}

/** The message a person can act on, or null when there is nothing to say. */
export function preflightMessage() {
  const { ok, problems } = preflight();
  if (ok) return null;
  const lines = ["", "Cannot launch Electron for this run:", ""];
  for (const [i, p] of problems.entries()) {
    lines.push(`  ${i + 1}. ${p.what}`, `     fix: ${p.fix}`, "");
  }
  lines.push(
    "  Electron runs belong on the M4, never on the head chef's Mac — see",
    "  ~/.claude-kitchen/projects/domo-desktop/wiki/m4-screenshots.md",
    "",
  );
  return lines.join("\n");
}

// Run directly: print and fail, so a `just` recipe stops here rather than
// launching something that will die without explaining itself.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const message = preflightMessage();
  if (message === null) {
    console.log("preflight ok: Electron is installed and the desktop build is present");
  } else {
    console.error(message);
    process.exit(1);
  }
}
