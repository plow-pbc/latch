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

  // Did the ENFORCED block lose content to the window's fixed height?
  //
  // This check outlived the feature that produced it. An owner-purpose row
  // once sat below the block and starved it; the row is gone, but the shape of
  // the failure is not — `.fine` is the flexible item in a fixed 460x560
  // window, so anything that grows beside it takes space from the one part of
  // this card that is a promise about what will happen, and at that size there
  // is no scrollbar to admit it. `styles.css` now floors the block, and this is
  // what proves the floor still holds.
  //
  // The obvious signal — are the buttons still on screen — is kept only to show
  // why it was never enough: the actions row is last, so it holds its place and
  // reports healthy while the block above it collapses.
  const metrics = await win.webContents.executeJavaScript(
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
  );

  console.log("SHOT:" + JSON.stringify({
    out,
    namesAgent: text.includes("Claude Code"),
    showsId: text.includes("sess_01HZX9K4M2QP"),
    ...metrics,
  }));
  // A clipped enforced block FAILS the run rather than being noted in passing.
  // The capability list is this window's entire reason to exist, so a build
  // that hides part of it is a broken build — and this is the only check that
  // sees the real window at its real size.
  app.exit(text.includes("Claude Code") && !metrics.enforcedClipped ? 0 : 1);
});
