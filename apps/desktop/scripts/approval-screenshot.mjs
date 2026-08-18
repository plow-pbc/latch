// Render the REAL approval window offscreen, with the REAL preload, and capture
// it. Evidence that the dialog names the calling agent — reproducible rather
// than a one-off image someone has to trust.
//
//   just approval-screenshot            → /tmp/approval-dialog.png
//   OUT=/path/to.png just approval-screenshot
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");
const out = process.env.OUT ?? "/tmp/approval-dialog.png";

// The view model approvalViewModel() builds from an intent whose agent identity
// came off the relay's request frame.
ipcMain.handle("approval:get", async () => ({
  kind: "intent",
  suggesting: false,
  view: {
    intentId: "9F2C1A44-0B77-4E3D-9A21-6C5E0D8B4417",
    agentDisplay: "Claude Code",
    agentId: "sess_01HZX9K4M2QP",
    goal: "Tidy up the quarterly report folder",
    request: "run: sips -Z 1600 ~/Documents/report/photos",
    planContext: null,
    // Device-side, from settings — the one line on this card the owner wrote.
    // PURPOSE overrides it, so the long-statement case (which is where the
    // fixed 460x560 window is under pressure) is reproducible rather than a
    // one-off edit someone made locally and threw away.
    agentPurpose:
      process.env.PURPOSE ??
      "Help with the quarterly report and the calendar. Never touch code or email.",
    capabilities: [
      { kind: "process.exec", display: "Run: sips -Z 1600 photos" },
      { kind: "fs.read", display: "Read: /Users/you/Documents/report/photos" },
      { kind: "fs.write", display: "Write: /Users/you/Documents/report/out" },
      { kind: "network", display: "Network: denied" },
    ],
    needsNetwork: false,
    writesFiles: true,
    runsCommand: true,
  },
}));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
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
  await win.loadFile(path.join(dist, "renderer/approval.html"));
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(out, image.toPNG());
  const text = await win.webContents.executeJavaScript("document.body.innerText");
  console.log("SHOT:" + JSON.stringify({
    out,
    namesAgent: text.includes("Claude Code"),
    showsId: text.includes("sess_01HZX9K4M2QP"),
    // Case-insensitive: the label is uppercased by CSS (`.section-label`), and
    // innerText reports what is RENDERED, not what the source string said.
    showsPurpose: /you said agents here are for/i.test(text),
    // Whether the ENFORCED block lost content to the window's fixed height.
    //
    // The obvious signal — are the buttons still on screen — was the wrong one,
    // and reported healthy on a card that had gone bad: the actions row is
    // last, so it holds its place while `.fine` above it shrinks and clips.
    // What matters is that a long purpose statement pushes the capability list
    // (the one part of this card that is a promise about what will happen) out
    // of view, with no scrollbar at that size to say so. `enforcedClipped`
    // catches exactly that, and `enforcedHeight` says how little was left.
    ...(await win.webContents.executeJavaScript(
      `(() => {
         const fine = document.querySelector(".fine");
         const actions = document.querySelector(".actions");
         return {
           enforcedClipped: fine.scrollHeight > fine.clientHeight,
           enforcedHeight: Math.round(fine.getBoundingClientRect().height),
           enforcedContentHeight: fine.scrollHeight,
           actionsOnScreen:
             actions.getBoundingClientRect().bottom <= window.innerHeight &&
             actions.getBoundingClientRect().top >= 0,
         };
       })()`,
    )),
  }));
  app.exit(text.includes("Claude Code") ? 0 : 1);
});
