// Copy the renderer assets (html/css/js — plain files tsc doesn't emit) into
// dist/renderer so the packaged app can load them via loadFile().
//
// It also PARSES the renderer scripts on the way past, because nothing else in
// the build does. `tsc -b` never sees them — they are plain files, copied, not
// compiled — so a syntax error in one used to travel the whole way to a window:
// the module fails to evaluate, no handlers bind, and the app opens inert with
// every tab dead. That shipped once, and only a human clicking found it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(dir, "../src/renderer");
const dest = path.join(dir, "../dist/renderer");

// Directories too, now that the Vault tab ships its own fonts: a packaged app
// has no network, and a design that falls back to the system face is not the
// design.
// Parse before copying: a broken file should stop the build, not be installed
// into dist and found later. `--check` only parses — nothing here is executed —
// and the workspace is `"type": "module"`, so a renderer `.js` is read with the
// same module goal the browser gives it.
const scripts = fs
  .readdirSync(src, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
  .sort();

// Fail on the first one. `node --check` already names the file, the line and
// the reason on stderr, so this inherits its output rather than capturing it to
// print a worse copy — and throwing here is the failure, no exit code to
// assemble by hand.
for (const file of scripts) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

fs.cpSync(src, dest, { recursive: true });
console.log(`copied renderer assets → ${dest} (${scripts.length} scripts parsed)`);
