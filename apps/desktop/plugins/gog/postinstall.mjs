#!/usr/bin/env node
/**
 * gog's post-extraction safety assertion, run against the binary in hand.
 *
 * `gogFlags.ts` refuses a closed set of spellings; kong can mint a SECOND long
 * spelling for a boolean flag, `--no-<name>`, which would disarm a belt flag
 * while matching neither the set nor either rule. Zero flags are negatable at
 * 0.36.0 — asserted here so a pin bump fails the fetch rather than shipping a
 * binary whose grammar the gate cannot see.
 *
 * THIS COMMENT IS THE ONLY ACCOUNT OF WHAT THE GUARD COVERS. `gogFlags.ts`
 * points here rather than restating it.
 *
 * Covers: a renamed `flags` or `subcommands` key. Either drops the count far
 * below the floor (this walk re-counts globals under every subcommand, so it
 * sees ~17k at 0.36.0), so the fetch fails instead of certifying zero negatable
 * flags from a key nothing reads.
 *
 * Does NOT cover: a renamed `negated` key — the count stays intact and the list
 * stays empty. Only step 3's hand probes bear on that, which is why they are
 * not optional on a bump.
 */
import { execFileSync } from "node:child_process";

function gogNoNegatableFlags(binary) {
  const schema = JSON.parse(
    execFileSync(binary, ["--no-input", "schema", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const negatable = [];
  let flagsSeen = 0;
  const walk = (node) => {
    for (const f of node.flags ?? []) {
      flagsSeen++;
      if (f.negated) negatable.push(f.name);
    }
    for (const sub of node.subcommands ?? []) walk(sub);
  };
  walk(schema.command ?? {});
  if (flagsSeen < 500) {
    throw new Error(`only ${flagsSeen} flags parsed from gog's schema — has its shape changed?`);
  }
  if (negatable.length > 0) {
    throw new Error(
      `negatable flags found, which gogFlags.ts cannot see: ${negatable.join(", ")}. ` +
        `Canonicalise --no-X to --X there before bumping the pin.`,
    );
  }
  return `${flagsSeen} flags checked, none negatable`;
}

console.log(gogNoNegatableFlags("gog"));
