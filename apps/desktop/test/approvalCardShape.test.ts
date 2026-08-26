import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The approval card's shape, checked against the source text.
 *
 * Source-shaped assertions are a poor substitute for executing the renderer,
 * and they are here because nothing else in this repo can. `approval.js` is a
 * browser module: `tsc` does not type it, no vitest environment provides a
 * DOM, and the one gate that does render it — `just verify-preload` — needs
 * Electron with a display, so it cannot run in this suite or on a headless
 * Linux host.
 *
 * That gap is not theoretical. A restructure landed the rebuilt card inside
 * the `req.kind === "access"` branch, clobbering that branch's render and
 * leaving the approve path with none; the access card then referenced `v`
 * before its `const`, a TDZ ReferenceError, and the approval window rendered
 * nothing at all. Syntax checks and the unit suite were both green. Four
 * consecutive rounds changed this file with nothing pinning it.
 *
 * So these assert the two invariants whose violation is silent: the approve
 * path builds a card at all, and the two blocks a sibling's height must never
 * displace stay outside the scrolling region. Delete this file the day the
 * renderer can be executed under test.
 */
const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/renderer/approval.js"),
  "utf8",
);

describe("the approval card's structure", () => {
  it("renders on the approve path, after the view is bound", () => {
    const vBound = source.indexOf("const v = req.view");
    expect(vBound).toBeGreaterThan(-1);
    // A `replaceChildren` after the binding is the approve card; without one
    // the window renders nothing, and referencing `v` above it is a TDZ throw.
    expect(source.indexOf("root.replaceChildren(", vBound)).toBeGreaterThan(vBound);
  });

  it("still renders the access card on its own branch", () => {
    const accessBranch = source.indexOf('req.kind === "access"');
    const vBound = source.indexOf("const v = req.view");
    const accessRender = source.indexOf("root.replaceChildren(", accessBranch);
    expect(accessBranch).toBeGreaterThan(-1);
    expect(accessRender).toBeGreaterThan(accessBranch);
    expect(accessRender).toBeLessThan(vBound);
  });

  it("keeps the enforceable block and the actions outside the scroll region", () => {
    const region = source.indexOf('class: "scroll-region"');
    expect(region).toBeGreaterThan(-1);
    const regionCloses = source.indexOf("    ]),", region);
    // Both must sit AFTER the region closes. Inside it, a long request line or
    // a long reviewer note can push the capability chips — or the Deny /
    // Always Allow / Allow Once row — past the window's clipped edge.
    expect(source.indexOf('class: "fine"', region)).toBeGreaterThan(regionCloses);
    expect(source.indexOf('class: "actions"', region)).toBeGreaterThan(regionCloses);
  });
});
