/**
 * `worktree-setup.sh` is what makes a new checkout runnable, and its whole
 * point is a failure that hides: `npm install` leaves a 256 KB Electron stub
 * with no `path.txt`, everything looks installed, and the app only throws
 * "Electron failed to install correctly" at launch. This drives the real
 * script against a fixture — fake `git` and `just` on PATH, real `node` — to
 * prove it detects that stub, clones a working binary, and refuses to report
 * a worktree ready when it could not.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));

let root: string;
let main: string;
let work: string;

/** A checkout with an electron package; `real` decides stub vs runnable. */
function plantElectron(checkout: string, real: boolean, version = "33.4.11"): void {
  const pkg = path.join(checkout, "node_modules/electron");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "electron", version }));
  // The real package resolves its binary through path.txt; so does this.
  fs.writeFileSync(
    path.join(pkg, "index.js"),
    `const fs=require("fs"),path=require("path");
     const p=path.join(__dirname,"path.txt");
     if(!fs.existsSync(p)) throw new Error("Electron failed to install correctly");
     module.exports=path.join(__dirname,"dist",fs.readFileSync(p,"utf8"));`,
  );
  if (!real) return; // the stub: dist exists, path.txt does not
  const bin = path.join(pkg, "dist/Electron.app/Contents/MacOS");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "Electron"), "#!/bin/sh\necho v33.4.11\n", { mode: 0o755 });
  fs.writeFileSync(path.join(pkg, "path.txt"), "Electron.app/Contents/MacOS/Electron");
}

/** Fake `git` answering only what the script asks, and a no-op `just`. */
function fakeTools(): string {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh
case "$*" in
  "worktree list --porcelain") printf 'worktree %s\\nbranch refs/heads/main\\n' "${main}" ;;
  *"--git-common-dir"*) printf '%s/.git\\n' "${main}" ;;
  *) exit 0 ;;
esac`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "just"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return bin;
}

function runSetup(): { status: number | null; output: string } {
  const bin = fakeTools();
  const run = execFileSync("bash", [path.join(work, "scripts/worktree-setup.sh")], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { status: 0, output: run };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-setup-"));
  main = path.join(root, "main");
  work = path.join(root, "feature");
  for (const checkout of [main, work]) {
    fs.mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "package.json"), `{"name":"latch","type":"module"}`);
    for (const s of ["worktree-setup.sh", "worktree-name.sh"]) {
      fs.copyFileSync(path.join(scripts, s), path.join(checkout, "scripts", s));
    }
  }
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("worktree-setup.sh", () => {
  it("detects the stub electron and clones a runnable one from the main checkout", () => {
    plantElectron(main, true);
    plantElectron(work, false);
    // The stub is exactly what npm leaves: a dist, and no path.txt.
    expect(fs.existsSync(path.join(work, "node_modules/electron/path.txt"))).toBe(false);

    const { output } = runSetup();

    expect(output).toContain("cloning node_modules/electron/dist from the main checkout");
    expect(output).toMatch(/electron ready: .*Electron/);
    expect(output).toContain("is ready");
    // And the worktree can now resolve it the way the app does.
    const resolved = execFileSync("node", ["-p", 'require("electron")'], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    expect(fs.statSync(resolved).mode & 0o111).toBeTruthy();
  });

  it("leaves a worktree that already has a runnable electron alone", () => {
    plantElectron(main, true);
    plantElectron(work, true);

    const { output } = runSetup();

    expect(output).toContain("electron already installed");
    expect(output).not.toContain("cloning node_modules/electron/dist");
  });

  it("refuses to report ready when it could not produce a runnable electron", () => {
    // The donor is a stub too — the case that used to print a note, carry on,
    // and hand back a worktree whose only symptom appears at launch.
    plantElectron(main, false);
    plantElectron(work, false);

    expect(() => runSetup()).toThrow();
    try {
      runSetup();
    } catch (error) {
      const said = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`;
      expect(said).toContain("does not resolve to a runnable binary");
      expect(said).not.toContain("is ready");
    }
  });

  it("refuses when the donor's electron is a different version", () => {
    plantElectron(main, true, "30.0.0");
    plantElectron(work, false, "33.4.11");

    try {
      runSetup();
      throw new Error("expected a nonzero exit");
    } catch (error) {
      const said = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`;
      expect(said).toContain("this one wants 33.4.11");
      expect(said).toContain("does not resolve to a runnable binary");
      expect(said).not.toContain("is ready");
    }
  });
});
