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
console.log(`copied renderer assets → ${dest}`);
