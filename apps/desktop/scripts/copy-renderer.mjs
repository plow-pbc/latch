// Copy the renderer assets (html/css/js — plain files tsc doesn't emit) into
// dist/renderer so the packaged app can load them via loadFile().
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(dir, "../src/renderer");
const dest = path.join(dir, "../dist/renderer");

// Directories too, now that the Vault tab ships its own fonts: a packaged app
// has no network, and a design that falls back to the system face is not the
// design.
fs.cpSync(src, dest, { recursive: true });
console.log(`copied renderer assets → ${dest}`);
