import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classifyArgv, ruleArgv } from "../src/plugins/argvRules.js";
import { resolveEnv } from "../src/plugins/env.js";
import { parseManifest } from "../src/plugins/manifest.js";
import { loadPlugins } from "../src/plugins/registry.js";
import { tempDirs } from "./pluginFixtures.js";

const pluginDir = fileURLToPath(new URL("../../../apps/desktop/plugins/screenpipe", import.meta.url));
const manifest = parseManifest(fs.readFileSync(path.join(pluginDir, "latch-plugin.json"), "utf8"));
const { tmp, cleanup } = tempDirs("latch-screenpipe-");
afterEach(cleanup);

function installer(incomplete = false, arch = "arm64") {
  const root = tmp();
  const installRoot = path.join(root, "Owner Profile", ".screenpipe", "latch-cli");
  const payload = path.join(root, "payload", "package");
  fs.mkdirSync(path.join(payload, "bin"), { recursive: true });
  fs.writeFileSync(path.join(payload, "bin", "screenpipe"), "synthetic engine");
  const resource = arch === "arm64" ? "mlx.metallib" : "libonnxruntime.dylib";
  fs.writeFileSync(path.join(payload, "bin", resource), "synthetic native resource");
  if (!incomplete) fs.writeFileSync(path.join(payload, "LICENSE.md"), "synthetic license");
  const archive = path.join(root, "release.tgz");
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", path.join(root, "payload"), "package"]);
  const checksum = createHash("sha512").update(fs.readFileSync(archive)).digest("hex");
  const capture = path.join(root, "request.json");
  const curl = path.join(root, "curl");
  fs.writeFileSync(curl, `#!${process.execPath}
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.writeFileSync(process.env.TEST_CAPTURE, JSON.stringify(argv));
if (process.env.TEST_NETWORK_ERROR) process.exit(7);
fs.copyFileSync(process.env.TEST_ARCHIVE, argv[argv.indexOf("--output") + 1]);
if (process.env.TEST_CORRUPT) fs.appendFileSync(argv[argv.indexOf("--output") + 1], "corrupt");
`, { mode: 0o755 });
  const uname = path.join(root, "uname");
  fs.writeFileSync(uname, `#!${process.execPath}
process.stdout.write(process.argv[2] === "-s" ? (process.env.TEST_OS ?? "Darwin") : (process.env.TEST_ARCH ?? "arm64"));
`, { mode: 0o755 });
  const source = fs.readFileSync(path.join(pluginDir, "install.sh"), "utf8");
  fs.writeFileSync(path.join(root, "install.sh"), source.replace("/usr/bin/curl", curl)
    .replaceAll("/usr/bin/uname", uname).replace(/checksum=[a-f0-9]{128}/g, `checksum=${checksum}`));
  fs.copyFileSync(path.join(pluginDir, "cli.sh"), path.join(root, "cli.sh"));
  return {
    root, installRoot, capture, checksum,
    release: (arch = "arm64") => path.join(installRoot, `0.4.52-${arch}`),
    run: (env: NodeJS.ProcessEnv = {}, argv: string[] = []) => spawnSync("/bin/sh", ["cli.sh", "install", ...argv], {
      cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, TMPDIR: root,
        SCREENPIPE_INSTALL_DIR: installRoot, TEST_CAPTURE: capture, TEST_ARCHIVE: archive, ...env },
    }),
  };
}

// Substitute only curl in a disposable copy. Production always uses the
// system binary; the fixture records its argv/stdin without opening a port.
function cli(key: string | null = "sp-test-key") {
  const root = tmp();
  const capture = path.join(root, "request.json");
  const keyFile = path.join(root, "api-key");
  if (key !== null) fs.writeFileSync(keyFile, key, { mode: 0o600 });
  const curl = path.join(root, "curl");
  fs.writeFileSync(curl, `#!${process.execPath}
import fs from "node:fs";
const argv = process.argv.slice(2);
const config = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({ argv, config }));
const body = process.env.TEST_LARGE_BODY ? "x".repeat(8 * 1024 * 1024) : (process.env.TEST_BODY ?? '{"data":[],"pagination":{"limit":20,"offset":0,"total":0}}');
fs.writeFileSync(argv[argv.indexOf("--output") + 1], body);
process.stdout.write(process.env.TEST_STATUS ?? "200");
process.exit(Number(process.env.TEST_CURL_EXIT ?? "0"));
`, { mode: 0o755 });
  const script = path.join(root, "cli.sh");
  const source = fs.readFileSync(path.join(pluginDir, "cli.sh"), "utf8");
  expect(source.match(/\/usr\/bin\/curl/g)).toHaveLength(1);
  fs.writeFileSync(script, source.replace("/usr/bin/curl", curl));
  return {
    root,
    capture,
    request: (): unknown => JSON.parse(fs.readFileSync(capture, "utf8")),
    run: (argv: string[], env: NodeJS.ProcessEnv = {}) => spawnSync("/bin/sh", [script, ...argv], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, TMPDIR: root, SCREENPIPE_API_PORT: "3030", SCREENPIPE_API_KEY_FILE: keyFile, TEST_CAPTURE: capture, ...env },
    }),
  };
}

describe("bundled Screenpipe manifest", () => {
  it("loads without downloaded binaries and resolves only owner configuration", () => {
    const plugin = loadPlugins([path.dirname(pluginDir)]).find((p) => p.manifest.name === "screenpipe");
    expect(plugin?.manifest.exec.argv).toEqual(["/bin/sh", "cli.sh"]);
    expect(manifest.runtime.binaries).toEqual([]);
    expect(manifest.daemon).toBeNull();
    expect(manifest.hooks).toEqual({});
    expect(resolveEnv(manifest, { pluginHome: pluginDir, ownerHome: "/owner" })).toEqual({
      SCREENPIPE_API_PORT: "3030", SCREENPIPE_API_KEY_FILE: "/owner/.config/plow-latch/screenpipe-api-key",
      SCREENPIPE_INSTALL_DIR: "/owner/.screenpipe/latch-cli",
    });
  });

  it.each(["health", "search", "--help"])("classifies %s as a read", (command) => {
    expect(classifyArgv(manifest, ["plow-screenpipe", command]).kind).toBe("read");
  });

  it.each(["record", "stop", "sql", "export-video", "notify", "pipe", "control", "--url"])("refuses %s", (command) => {
    expect(classifyArgv(manifest, ["plow-screenpipe", command]).kind).toBe("refused");
  });

  it("uses the existing read-prefix rule for different searches", () => {
    expect(ruleArgv(manifest, ["plow-screenpipe", "search", "--query", "one"])).toEqual(["plow-screenpipe", "search"]);
    expect(ruleArgv(manifest, ["plow-screenpipe", "search", "--query", "two", "--content-type", "audio"])).toEqual(["plow-screenpipe", "search"]);
    expect(manifest.argv.write).toEqual([["install"]]);
    expect(classifyArgv(manifest, ["plow-screenpipe", "install"]).kind).toBe("write");
    expect(ruleArgv(manifest, ["plow-screenpipe", "install"])).toEqual(["plow-screenpipe", "install"]);
  });
});

describe("Screenpipe CLI", () => {
  it("prints help without a request or reading a malformed key", () => {
    const fixture = cli("malformed key");
    const result = fixture.run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("network=true");
    expect(fs.existsSync(fixture.capture)).toBe(false);
  });

  it("reads health without authentication", () => {
    const fixture = cli("malformed key");
    expect(fixture.run(["health"]).status).toBe(0);
    expect(fixture.request()).toMatchObject({ config: "", argv: expect.arrayContaining(["http://127.0.0.1:3030/health"]) });
  });

  it("passes the JSON envelope unchanged and keeps the token out of argv", () => {
    const fixture = cli();
    const json = JSON.stringify({ data: [{ type: "Audio", content: { transcription: "Synthetic meeting", timestamp: "2026-10-01T12:00:00Z" } }], pagination: { total: 1, limit: 20, offset: 0 } });
    const result = fixture.run(["search"], { TEST_BODY: json });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(json);
    expect(fixture.request()).toMatchObject({
      config: 'header = "Authorization: Bearer sp-test-key"\n',
      argv: expect.arrayContaining(["-q", "--config", "-", "--get", "--proxy", "", "--noproxy", "*", "--max-time", "15", "include_frames=false", "include_cloud=false", "max_content_length=2000", "limit=20"]),
    });
    expect(fixture.request()).toMatchObject({ argv: expect.not.arrayContaining([expect.stringContaining("sp-test-key")]) });
    expect(fixture.request()).toMatchObject({ argv: expect.not.arrayContaining(["--location"]) });
    expect(fs.readdirSync(fixture.root).filter((name) => name.startsWith("latch-screenpipe."))).toEqual([]);
  });

  it("treats special query characters and file-shaped values as encoded data", () => {
    const fixture = cli();
    const query = '@secret &token=other; $(touch /tmp/should-not-exist) "quoted"';
    const result = fixture.run(["search", "--query", query, "--content-type", "audio", "--app-name", "Google Chrome", "--window-name", "Design & review", "--start-time", "2026-10-01T09:00:00-03:00", "--end-time", "2026-10-01T10:00:00-03:00", "--limit", "100", "--offset", "20", "--order", "asc"]);
    expect(result.status).toBe(0);
    expect(fixture.request()).toMatchObject({ argv: expect.arrayContaining([
      "--data-urlencode", `q=${query}`, "content_type=audio", "app_name=Google Chrome", "window_name=Design & review",
      "start_time=2026-10-01T09:00:00-03:00", "end_time=2026-10-01T10:00:00-03:00", "limit=100", "offset=20", "order=ascending",
    ]) });
  });

  it.each(["all", "ocr", "audio", "input", "accessibility", "parsed"])("supports %s searches", (type) => {
    expect(cli().run(["search", "--content-type", type]).status).toBe(0);
  });

  it.each([["asc", "ascending"], ["desc", "descending"]])("translates --order %s into Screenpipe's %s API value", (order, value) => {
    const fixture = cli();
    expect(fixture.run(["search", "--order", order]).status).toBe(0);
    expect(fixture.request()).toMatchObject({ argv: expect.arrayContaining([`order=${value}`]) });
    expect(fixture.request()).toMatchObject({ argv: expect.not.arrayContaining([`order=${order}`]) });
  });

  it.each([
    [], ["record"], ["install", "--url", "https://example.com"], ["health", "--url", "https://example.com"], ["--help", "extra"],
    ["search", "--query"], ["search", "--url", "https://example.com"], ["search", "--config", "/tmp/config"],
    ["search", "--header", "Authorization: Bearer other"], ["search", "--include-frames", "true"],
    ["search", "--content-type", "video"], ["search", "--order", "random"],
    ["search", "--limit", "0"], ["search", "--limit", "101"], ["search", "--limit", "1e2"],
    ["search", "--limit", "999999999999999999999"], ["search", "--offset", "-1"], ["search", "--offset", "1000001"],
    ["search", "--query", "x".repeat(4097)],
  ])("refuses invalid argv case %# before HTTP", (...argv) => {
    const fixture = cli();
    expect(fixture.run(argv).status).toBe(2);
    expect(fs.existsSync(fixture.capture)).toBe(false);
  });

  it.each(["", "sp-secret\nurl = https://example.com", 'sp-secret"', "sp-secret\\", "sp-secret key"])("refuses malformed token case %# without echoing it", (key) => {
    const fixture = cli(key);
    const result = fixture.run(["search"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("sp-secret");
    expect(fs.existsSync(fixture.capture)).toBe(false);
  });

  it("supports an unauthenticated instance when the owner has no key file", () => {
    const fixture = cli(null);
    expect(fixture.run(["search"]).status).toBe(0);
    expect(fixture.request()).toMatchObject({ config: "" });
  });

  it.each(["0", "65536", "3030/other", "localhost:3030"])("refuses invalid owner port %s", (port) => {
    const fixture = cli();
    expect(fixture.run(["health"], { SCREENPIPE_API_PORT: port }).status).toBe(1);
    expect(fs.existsSync(fixture.capture)).toBe(false);
  });

  it.each([
    ["401", "authentication"], ["403", "authentication"], ["302", "Redirects are refused"],
    ["400", "parameters"], ["404", "API version"], ["500", "HTTP error"],
  ])("suppresses HTTP %s response bodies", (status, hint) => {
    const fixture = cli();
    const result = fixture.run(["search"], { TEST_STATUS: status, TEST_BODY: "sp-secret-key and private history" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(hint);
    expect(result.stderr).not.toContain("sp-secret");
    expect(fs.readdirSync(fixture.root).filter((name) => name.startsWith("latch-screenpipe."))).toEqual([]);
  });

  it.each([["7", "Start Screenpipe"], ["28", "15 seconds"], ["63", "size limit"]])("reports curl exit %s without partial output", (code, hint) => {
    const result = cli().run(["search"], { TEST_CURL_EXIT: code, TEST_BODY: "partial private history" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(hint);
  });

  it("bounds the response file and removes it even when the transport exceeds the limit", () => {
    const fixture = cli();
    const result = fixture.run(["search"], { TEST_LARGE_BODY: "1" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(fs.readdirSync(fixture.root).filter((name) => name.startsWith("latch-screenpipe."))).toEqual([]);
  });
});

describe("owner-approved Screenpipe installation", () => {
  it.each(["arm64", "x86_64"])("installs the pinned %s release with native resources and license", (arch) => {
    const fixture = installer(false, arch);
    const result = fixture.run({ TEST_ARCH: arch });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(fixture.release(arch), ".package-integrity"), "utf8").trim()).toBe(fixture.checksum);
    expect(fs.readFileSync(path.join(fixture.release(arch), "bin", arch === "arm64" ? "mlx.metallib" : "libonnxruntime.dylib"), "utf8")).toBe("synthetic native resource");
    expect(fs.existsSync(path.join(fixture.release(arch), "LICENSE.md"))).toBe(true);
    const argv: unknown = JSON.parse(fs.readFileSync(fixture.capture, "utf8"));
    expect(argv).toEqual(expect.arrayContaining(["-q", "--proto", "=https", "--max-time", "300",
      `https://registry.npmjs.org/@screenpipe/cli-darwin-${arch === "arm64" ? "arm64" : "x64"}/-/cli-darwin-${arch === "arm64" ? "arm64" : "x64"}-0.4.52.tgz`]));
    expect(fs.readdirSync(fixture.installRoot)).toEqual([`0.4.52-${arch}`]);
  });

  it("reuses the installed release with no network access or archive extraction", () => {
    const fixture = installer();
    expect(fixture.run().status).toBe(0);
    fs.rmSync(fixture.capture);
    const repeat = fixture.run({ TEST_NETWORK_ERROR: "1" });
    expect(repeat.status).toBe(0);
    expect(repeat.stdout).toContain("already installed");
    expect(fs.existsSync(fixture.capture)).toBe(false);
  });

  it.each([{ TEST_OS: "Linux" }, { TEST_ARCH: "riscv64" }])("refuses unsupported platform %j before download or writes", (env) => {
    const fixture = installer();
    expect(fixture.run(env).status).toBe(1);
    expect(fs.existsSync(fixture.capture)).toBe(false);
    expect(fs.existsSync(fixture.installRoot)).toBe(false);
  });

  it.each([{ TEST_NETWORK_ERROR: "1" }, { TEST_CORRUPT: "1" }])("cleans up a failed or corrupt download %j without publishing a release", (env) => {
    const fixture = installer();
    expect(fixture.run(env).status).toBe(1);
    expect(fs.readdirSync(fixture.installRoot)).toEqual([]);
    expect(fs.readdirSync(fixture.root).some((name) => name.startsWith("latch-screenpipe-install."))).toBe(false);
  });

  it("refuses an incomplete verified package and removes its staging directory", () => {
    const fixture = installer(true);
    expect(fixture.run().status).toBe(1);
    expect(fs.readdirSync(fixture.installRoot)).toEqual([]);
  });

  it("preserves an existing incomplete release instead of overwriting it", () => {
    const fixture = installer();
    fs.mkdirSync(fixture.release(), { recursive: true });
    fs.writeFileSync(path.join(fixture.release(), "keep"), "owner data");
    expect(fixture.run().status).toBe(1);
    expect(fs.readFileSync(path.join(fixture.release(), "keep"), "utf8")).toBe("owner data");
    expect(fs.existsSync(fixture.capture)).toBe(false);
  });

  it("does not interfere with an installation holding the lock", () => {
    const fixture = installer();
    fs.mkdirSync(path.join(fixture.installRoot, ".install-lock"), { recursive: true });
    expect(fixture.run().status).toBe(1);
    expect(fs.existsSync(fixture.capture)).toBe(false);
    expect(fs.existsSync(path.join(fixture.installRoot, ".install-lock"))).toBe(true);
  });
});
