// Render the REAL audit screen offscreen, with the REAL preload, mid browsing
// session — and capture the live-browser thumbnail pinned in the detail pane's
// bottom-right corner. Evidence that the owner can watch what the agent's
// browser is doing — reproducible rather than a one-off image someone has to
// trust.
//
//   just viewer-screenshot            → /tmp/browser-viewer.png
//   OUT=/path/to.png just viewer-screenshot
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");
const out = process.env.OUT ?? "/tmp/browser-viewer.png";

// A stand-in for a Camoufox frame: a mock webpage drawn on a canvas in a
// hidden sandboxed window (the main process can't draw — devIcon pattern).
async function fakeFrame() {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadURL("about:blank");
    const dataUrl = await win.webContents.executeJavaScript(`(() => {
      const c = document.createElement("canvas");
      c.width = 1280; c.height = 800;
      const g = c.getContext("2d");
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, 1280, 800);
      g.fillStyle = "#b91c1c"; g.fillRect(0, 0, 1280, 72);
      g.fillStyle = "#ffffff"; g.font = "bold 30px sans-serif";
      g.fillText("Pizza Palace", 28, 47);
      g.fillStyle = "#18181b"; g.font = "24px sans-serif";
      g.fillText("Menu", 28, 130);
      g.font = "18px sans-serif"; g.fillStyle = "#3f3f46";
      ["Pepperoni — $14", "Margherita — $12", "Quattro Formaggi — $16"].forEach((t, i) =>
        g.fillText(t, 28, 175 + i * 36));
      g.fillStyle = "#16a34a"; g.fillRect(28, 300, 180, 44);
      g.fillStyle = "#ffffff"; g.font = "bold 17px sans-serif";
      g.fillText("Add to cart", 62, 328);
      return c.toDataURL("image/jpeg", 0.8);
    })()`);
    return dataUrl.split(",")[1];
  } finally {
    win.destroy();
  }
}

// Destroying the frame-drawing window would otherwise trigger Electron's
// default quit-on-last-window-closed and abort the main-window load.
app.on("window-all-closed", () => {});

// Stub the IPC surface the audit screen pulls on load (verify-preload pattern):
// one in-flight browsing activity, and a live viewer state with a real frame.
ipcMain.handle("status:get", async () => ({ deviceId: "probe", name: "Probe", connected: true }));
ipcMain.handle("ui:getTab", async () => "audit");
ipcMain.handle("ui:setTab", async () => {});
ipcMain.handle("audit:activities", async () => [
  {
    id: "act-1",
    time: "16:20:05",
    tone: "green",
    status: "Browsing",
    title: "Browse pizza.example",
    kind: "browser",
    category: "approved",
    agentDisplay: "Pizza Agent",
    agentId: "sess_01HZX9K4M2QP",
    goal: "Order a pepperoni pizza for tonight",
    command: null,
    intentId: "9F2C1A44-0B77-4E3D-9A21-6C5E0D8B4417",
    exitCode: null,
    capabilities: ["browse: pizza.example, *.pizza.example", "credentials: list names/labels"],
    decidedBy: "You approved it",
    timeline: [
      { text: "Session opened for pizza.example", time: "16:20:05", state: "ok" },
      { text: "Visited pizza.example/menu", time: "16:20:11", state: "ok" },
      { text: "Screenshot taken", time: "16:20:14", state: "" },
    ],
  },
]);

app.whenReady().then(async () => {
  const dataB64 = await fakeFrame();
  // The shape viewer:state serves in the app, mid-session.
  ipcMain.handle("viewer:state", async () => ({
    active: true,
    origins: ["pizza.example", "*.pizza.example"],
    inScope: true,
    url: "https://pizza.example/menu",
    frame: { dataB64, mime: "image/jpeg" },
  }));

  const win = new BrowserWindow({
    width: 940,
    height: 620,
    show: false,
    webPreferences: {
      preload: path.join(dist, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadFile(path.join(dist, "renderer/index.html"));
  await new Promise((r) => setTimeout(r, 700)); // render + first thumb poll + decode
  const image = await win.webContents.capturePage();
  fs.writeFileSync(out, image.toPNG());
  const probe = await win.webContents.executeJavaScript(`(${() => {
    const img = document.querySelector(".live-corner img");
    return {
      thumbVisible: !!img && img.offsetParent !== null && img.naturalWidth > 0,
      caption: document.querySelector(".live-cap")?.textContent ?? "",
      // The thumbnail must sit outside the timeline scroller.
      outsideScroll: !img?.closest(".detail-scroll"),
    };
  }})()`);
  const ok = probe.thumbVisible && probe.outsideScroll && probe.caption.includes("pizza.example");
  console.log("SHOT:" + JSON.stringify({ out, ...probe, ok }));
  app.exit(ok ? 0 : 1);
});
