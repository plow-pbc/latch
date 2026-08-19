// Drive the PRODUCTION path end to end against real Electron: a relay socket
// frame goes in one end, and a real approval window changes at the other.
//
// Nothing here reaches past the seams the app itself uses. The RelayClient is
// the real one, wired by `relayOptions` — the same function `main.ts` builds
// its client from — over a real `createDomoMcpServer` and a real `DeviceAgent`,
// with the real preload and renderer in a real BrowserWindow. The only thing
// standing in is the SOCKET: frames are handed to the client the way the relay
// would hand them over, because the relay lives in another repository and is
// not running here.
//
// So the acknowledgement that moves the window to "backgrounded" arrives as a
// `relay.response.ack` frame off that socket and travels
// RelayClient → onResponseAck → server.acknowledgeExchange → Continuations →
// the window. An earlier version of this script called the registry directly,
// which proved the registry and nothing about the wiring between them.
//
//   just continuation-verify
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { DeviceAgent } from "@domo/device-core";
import { createDomoMcpServer } from "@domo/mcp-server";
import { RelayClient } from "@domo/relay-client";
import { preflightMessage } from "./electron-preflight.mjs";

// The built modules are loaded AFTER the preflight, not imported at the top.
// A static import of a file an unbuilt tree does not have fails during module
// evaluation — before any of this can say why — which is the failure the
// preflight exists to explain.
let runApprovalWindow;
let relayOptions;
let approvalViewModel;

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");

const REPORT = process.env.VERIFY_OUT ?? "/tmp/continuation-verify.json";
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail ?? null });

/**
 * Written to a file as well as stdout: `app.exit()` can kill the process before
 * a piped stdout has flushed, and a verification whose output vanished reads
 * exactly like one that passed.
 */
const report = (body, code) => {
  const text = JSON.stringify(body, null, 2);
  fs.writeFileSync(REPORT, text);
  console.log("VERIFY:" + text);
  app.exit(code);
};
const die = (where) => (error) => report({ error: `${where}: ${error?.stack ?? error}` }, 2);
process.on("uncaughtException", die("uncaught"));
process.on("unhandledRejection", die("rejection"));

/**
 * Each scenario ends by destroying its window, and an Electron app with no
 * windows left quits — silently, exit 0, which reads exactly like a pass. This
 * run says for itself when it is finished.
 */
app.on("window-all-closed", () => {});

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const bodyText = (win) => win.webContents.executeJavaScript("document.body.innerText");

/** A socket with the relay on the other end of it. */
function scriptedSocket() {
  const sock = {
    frames: [],
    onLine: null,
    onClose: null,
    startReading() {},
    sendLine(line) {
      sock.frames.push(JSON.parse(line.toString("utf8")));
    },
    close() {},
    /** Hand the client a frame, as the relay would. */
    push(frame) {
      sock.onLine(Buffer.from(JSON.stringify(frame), "utf8"));
    },
    /** What this Mac sent back for `rid`, once it has sent anything. */
    responseFor(rid) {
      return sock.frames.find((f) => f.type === "relay.response" && f.rid === rid);
    },
  };
  return sock;
}

/** One MCP tools/call request frame, as the relay forwards it. */
function callFrame(rid, tool, args) {
  return {
    type: "relay.request",
    rid,
    method: "POST",
    path: "/mcp",
    // The header set modern MCP requires, and which the SDK checks against the
    // body: method in both places, and the tool's name alongside it.
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": tool,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: tool,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "verify", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
    auth: { agent_id: "sess_verify", agent_name: "Claude Code", scopes: [], user_uid: "u1" },
  };
}

/** The tool payload out of one relay response frame. */
function payloadOf(frame) {
  const rpc = JSON.parse(frame.body);
  return JSON.parse(rpc.result.content[0].text);
}

/** Click a rendered button by label, with real mouse events. */
async function click(win, label) {
  const rect = await win.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll("button")].find((n) => n.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!rect) return false;
  for (const type of ["mouseDown", "mouseUp"]) {
    win.webContents.sendInputEvent({ type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  }
  await settle();
  return true;
}

let copyCalls = 0;
ipcMain.handle("approval:copyPhrase", async () => {
  copyCalls += 1;
  return true;
});

/**
 * A whole Mac: device, MCP server, a relay client wired by `relayOptions`, and
 * a policy that opens the real approval window through the real opener — which
 * is how `main.ts` assembles the same four.
 */
async function bringUp(windows) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-verify-"));
  const opened = { win: null };
  let server;
  const device = new DeviceAgent(home, "Verify Mac", {
    decideIntent: async (intent) => {
      const decision = await runApprovalWindow(
        { kind: "intent", view: approvalViewModel(intent) },
        {
          ipc: ipcMain,
          createWindow: () => {
            opened.win = new BrowserWindow({
              width: 460,
              height: 560,
              show: false,
              webPreferences: {
                preload: path.join(dist, "preload.cjs"),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
              },
            });
            windows.push(opened.win);
            return opened.win;
          },
          loadFile: (w) => w.loadFile(path.join(dist, "renderer/approval.html")),
          continuation: {
            snapshot: (id) => ({
              state: server.continuations.stateOfIntent(id),
              deadlineAt: server.continuations.deadlineOfIntent(id),
              deliveryUnknown: server.continuations.deliveryUnknownOfIntent(id),
            }),
            subscribe: (listener) => {
              server.continuations.events.on("change", listener);
              return () => server.continuations.events.removeListener("change", listener);
            },
          },
          lingerMs: 120_000,
        },
      );
      return { decision, source: "ask" };
    },
  });
  // A short budget so the call defers while the window is still open, which is
  // the whole situation this feature exists for.
  server = createDomoMcpServer(device, { budgetMs: 800 });
  const sock = scriptedSocket();
  const relay = new RelayClient(
    relayOptions(server, {
      url: "ws://relay.invalid/relay",
      credential: "plow_sk_verify",
      dial: () => ({ connect: async () => sock }),
    }),
  );
  await relay.start();
  // The relay's handshake, ending in an auth.ok advertising the modern
  // contract: a deadline, and acknowledgements.
  sock.push({ type: "auth.challenge" });
  sock.push({ type: "auth.ok", exchange_deadline_ms: 25_000, response_ack: true });
  return { home, device, server, sock, relay, opened };
}

/** Wait for `probe()` to be truthy, or give up. */
async function until(probe, tries = 60, ms = 100) {
  for (let i = 0; i < tries; i++) {
    const value = await probe();
    if (value) return value;
    await settle(ms);
  }
  return null;
}

app.whenReady().then(async () => {
  // Electron clearly started, so this can only be a missing build — a window
  // with no preload renders nothing and every check would fail for a reason
  // that has nothing to do with what is being verified.
  const blocked = preflightMessage();
  if (blocked !== null) {
    report({ error: "preflight failed", guidance: blocked }, 3);
    return;
  }
  try {
    ({ runApprovalWindow } = await import("../dist/approvalWindow.js"));
    ({ relayOptions } = await import("../dist/relayWiring.js"));
    ({ approvalViewModel } = await import("../dist/viewModel.js"));
    await verify();
  } catch (error) {
    report({ error: `verify threw: ${error?.stack ?? error}` }, 2);
  }
}, die("whenReady"));

async function verify() {
  const windows = [];

  // ---- 1. A frame in; a backgrounded, then collected, window out ----------
  {
    const { server, sock, opened, home } = await bringUp(windows);
    // The handshake's advertised deadline reached the server through the same
    // wiring the acknowledgement uses.
    check(
      "the handshake configured the server's budgets",
      server.callBudgetMs() === 15_000 && server.directCeilingMs() === 15_000,
      `budget=${server.callBudgetMs()} ceiling=${server.directCeilingMs()}`,
    );
    // ...and then the test's own short budget, so the call defers while a human
    // is still reading.
    server.setCallBudgetMs(800);

    const file = path.join(home, "report.txt");
    fs.writeFileSync(file, "the numbers");
    // `operation_id` is required on every tool that can act twice (§6): a
    // frame without one is refused before it ever reaches an approval.
    sock.push(
      callFrame("RID-1", "read_file", {
        path: file,
        goal: "summarise it",
        operation_id: "verify-read-1",
      }),
    );

    const win = await until(() => opened.win);
    check("a relay frame opened the real approval window", !!win, lastServed(sock));
    if (!win) return finish();
    await settle(700);
    const inline = await bodyText(win);
    check(
      "the window counts down the call it arrived on",
      /~\d+s left/.test(inline),
      inline.slice(0, 70),
    );

    // The budget expires while the human reads: this Mac answers the exchange
    // with a pending handle of its own accord.
    const response = await until(() => sock.responseFor("RID-1"));
    check("the deferred answer went back on that exchange", !!response);
    const pending = response ? payloadOf(response) : null;
    check("and it is a pending handle, not a result", pending?.status === "pending", pending?.status);

    // THE WIRING UNDER TEST: an acknowledgement frame off the socket, travelling
    // RelayClient → onResponseAck → server.acknowledgeExchange → the window.
    sock.push({ type: "relay.response.ack", rid: "RID-1" });
    await settle(600);
    const backgrounded = await bodyText(win);
    check(
      "an ack FRAME moved the window to backgrounded",
      backgrounded.includes("stopped waiting"),
      backgrounded.slice(0, 70),
    );
    check(
      "and it names the phrase that brings the agent back",
      backgrounded.includes("Continue the pending Plow request."),
    );

    // Approve for real; the window becomes the compact confirmation.
    const before = win.getContentSize();
    check("Allow Once was clickable", await click(win, "Allow Once"));
    await settle(600);
    const after = win.getContentSize();
    check(
      "the real window resized to the confirmation",
      after[1] === 190 && before[1] > after[1],
      `${before.join("x")} -> ${after.join("x")}`,
    );

    // The work lands: a ready result nobody has asked for yet.
    const ready = await until(async () => {
      const text = await bodyText(win);
      return text.includes("Copy phrase") ? text : null;
    });
    check("the ready result offers the copy action", !!ready, ready?.slice(0, 70));
    check("copy IPC fired from a real click", (await click(win, "Copy phrase")) && copyCalls === 1);

    // The agent comes back for it — over the relay, as a second exchange.
    sock.push(callFrame("RID-2", "get_result", { handle: pending.handle }));
    const collected = await until(() => sock.responseFor("RID-2"));
    check("the agent's lookup was served over the relay", !!collected);
    check(
      "and it carried the result",
      collected ? JSON.stringify(payloadOf(collected)).includes("the numbers") : false,
    );
    await settle(700);
    check("collection destroyed the window", win.isDestroyed());
  }

  // ---- 2. A lost socket, through the same wiring --------------------------
  {
    const { server, sock, opened, home } = await bringUp(windows);
    server.setCallBudgetMs(800);
    const file = path.join(home, "b.txt");
    fs.writeFileSync(file, "x");
    sock.push(callFrame("RID-3", "read_file", { path: file, operation_id: "verify-read-2" }));
    const win = await until(() => opened.win);
    check("second window opened", !!win, lastServed(sock));
    if (!win) return finish();
    await until(() => sock.responseFor("RID-3"));

    // The socket dies with the exchange outstanding. RelayClient settles it as
    // unknown, and `onDeliveryUnknown` carries that to the server.
    sock.onClose?.();
    await settle(600);
    const unknown = await bodyText(win);
    check(
      "a dropped socket told the window delivery is unconfirmed",
      unknown.includes("could not confirm"),
      unknown.slice(0, 70),
    );
    check(
      "and it claims neither waiting nor handed off",
      !unknown.includes("still waiting") && !unknown.includes("stopped waiting"),
    );

    await click(win, "Deny");
    await settle(700);
    check("a denial closes the window even here", win.isDestroyed());
  }

  finish();

  function finish() {
    for (const w of windows) if (!w.isDestroyed()) w.close();
    const failed = checks.filter((c) => !c.ok);
    report({ checks, failed: failed.length }, failed.length === 0 ? 0 : 1);
  }
}

/** Whatever this Mac last put on the wire — the first thing to look at when a
 * frame did not produce the window it should have. */
function lastServed(sock) {
  const last = sock.frames.at(-1);
  return last ? JSON.stringify(last).slice(0, 220) : "nothing sent";
}
