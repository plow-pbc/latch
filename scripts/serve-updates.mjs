// Serve a directory as a local electron-updater feed (`just serve-updates`).
//
// Dependency-free static file server for testing the update loop against a
// packaged build: apps/desktop/release/ already holds exactly what a feed is —
// latest-mac.yml, the zip, and the blockmap. GET/HEAD only, loopback only,
// no Range support (electron-updater then falls back from differential to a
// full download — fine for a local test).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [dir, portArg] = process.argv.slice(2);
if (!dir) {
  console.error("usage: serve-updates.mjs <dir> [port]");
  process.exit(1);
}
const root = path.resolve(dir);
const port = Number(portArg ?? "8043");

const server = http.createServer((req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  // Resolve inside the served dir only; anything escaping it is a 404.
  const file = path.join(root, path.normalize(decodeURIComponent(url.pathname)));
  const ok =
    (method === "GET" || method === "HEAD") &&
    file.startsWith(root + path.sep) &&
    fs.existsSync(file) &&
    fs.statSync(file).isFile();
  if (!ok) {
    console.log(`  ${method} ${url.pathname} -> 404`);
    res.writeHead(404).end();
    return;
  }
  const size = fs.statSync(file).size;
  console.log(`  ${method} ${url.pathname} -> 200 (${size} bytes)`);
  res.writeHead(200, { "content-length": size });
  if (method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`serving ${root}`);
  console.log(`feed URL: http://127.0.0.1:${port}`);
  const yml = path.join(root, "latest-mac.yml");
  if (!fs.existsSync(yml)) {
    console.log("warning: no latest-mac.yml here yet — package first (just package-unnotarized)");
  }
});
