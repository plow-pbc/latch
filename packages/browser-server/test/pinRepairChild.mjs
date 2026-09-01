// One process's view of a shared stale pin: resolve the pinned fingerprint and
// print its id. Spawned many-at-once by pinRepairConcurrent.test.ts to prove
// concurrent repairers all converge on the same id.
import fs from "node:fs";
import { pinnedEntry } from "../dist/launch.js";

const [poolFile, pinPath, startAt] = process.argv.slice(2);
const pool = JSON.parse(fs.readFileSync(poolFile, "utf8"));
// Barrier: every child busy-waits to the same wall-clock instant, so they all
// enter pinnedEntry together and genuinely contend on the repair.
const start = Number(startAt);
while (Date.now() < start) {
  /* spin to the barrier */
}
process.stdout.write(pinnedEntry(pool, pinPath).id);
