// Copy the renderer assets (html/css/js — plain files tsc doesn't emit) into
// dist/renderer so the packaged app can load them via loadFile().
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(dir, "../src/renderer");
const dest = path.join(dir, "../dist/renderer");

fs.mkdirSync(dest, { recursive: true });
for (const file of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
}

// Pure presentation modules the renderer imports directly. They are compiled
// from TypeScript and unit-tested off-screen, which is the point: what the
// approval window CLAIMS is checkable without a display, and the window runs
// the very code those tests cover rather than a hand-copied twin of it.
// Copied in rather than imported across directories, so the sandboxed
// renderer only ever loads from its own folder.
for (const shared of ["continuationView.js"]) {
  fs.copyFileSync(path.join(dir, "../dist", shared), path.join(dest, shared));
}
console.log(`copied renderer assets → ${dest}`);
