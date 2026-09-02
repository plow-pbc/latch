/* What the screenshot scripts all do, once.
 *
 * Each of them stands a real window up on the real preload, walks a list of
 * screens, writes a PNG per screen and fails the run when a screen has lost
 * the content it exists to show. Only the screens differ; this is the rest.
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

/** A window with the shipping preload and no Node in the page. */
export function shotWindow(
  dist,
  { width = 940, height = 620, titleBarStyle, backgroundColor } = {},
) {
  return new BrowserWindow({
    width,
    height,
    ...(titleBarStyle ? { titleBarStyle } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    show: false,
    webPreferences: {
      preload: path.join(dist, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

/** Click by visible label, the way a person picks a button out of the page. */
export async function clickText(win, label, settleMs = 250) {
  const found = await win.webContents.executeJavaScript(`
    (() => {
      const el = [...document.querySelectorAll("button")]
        .find((b) => b.textContent.includes(${JSON.stringify(label)}));
      if (!el) return false;
      el.click();
      return true;
    })()
  `);
  if (!found) throw new Error(`no button labelled ${label}`);
  await new Promise((r) => setTimeout(r, settleMs));
}

/** Wait for something on the page rather than guessing how long it takes. */
export async function waitFor(win, expr, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await win.webContents.executeJavaScript(`!!(${expr})`);
    } catch {
      ok = false; // mid-navigation; ask again
    }
    if (ok) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Shoot every screen, and exit non-zero if one of them lost its content.
 *
 * `expect` is matched against the page's text case-insensitively — several of
 * these panes uppercase their labels in CSS, and this checks what the screen
 * says, not how it is set. `reject` fails on text a state must not render.
 * `expectValues` is matched against field values,
 * which is where a revealed secret lands. `expectFocus` is matched against the
 * focused element's label (its text, or an input's placeholder) — the screen's
 * promise that Return does what the highlighted control advertises.
 * `expectEnabled` names a button that must remain actionable in that state.
 * `rejectButton` names an exact button label that must not be rendered.
 * `expectNeutralNote` names connector status copy that must use neutral rather
 * than error styling.
 */
export async function shootScreens({ win, outDir, prefix, screens, load, beforeShot }) {
  fs.mkdirSync(outDir, { recursive: true });
  let failures = 0;
  for (const screen of screens) {
    await load(screen);
    await screen.prepare?.(win);
    await beforeShot?.(win, screen);

    const out = path.join(outDir, `${prefix}-${screen.name}.png`);
    fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());

    const text = (await win.webContents.executeJavaScript("document.body.innerText")).toLowerCase();
    const values = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll("input, textarea")].map((f) => f.value).join("\\n")`,
    );
    const title = await win.webContents.executeJavaScript("document.title");
    const ariaLabels = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label"))`,
    );
    const focused = await win.webContents.executeJavaScript(
      `(document.activeElement?.textContent || document.activeElement?.getAttribute("placeholder") || "").trim()`,
    );
    const enabledButtons = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll("button:not(:disabled)")].map((button) => button.textContent.trim())`,
    );
    const buttonLabels = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll("button")].map((button) => button.textContent.trim())`,
    );
    const neutralNotes = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll(".connector-note.neutral:not(.error)")].map((note) => note.textContent.trim())`,
    );
    const dotCount = await win.webContents.executeJavaScript(
      `document.querySelectorAll(".foot-dot").length`,
    );
    const bodyScrollTop = await win.webContents.executeJavaScript(
      `document.querySelector(".wizard-body")?.scrollTop ?? 0`,
    );
    const missing = [
      ...(screen.expect ?? []).filter((needle) => !text.includes(needle.toLowerCase())),
      ...(screen.reject ?? [])
        .filter((needle) => text.includes(needle.toLowerCase()))
        .map((needle) => `unexpected text "${needle}"`),
      ...(screen.expectValues ?? []).filter((needle) => !values.includes(needle)),
      ...(screen.expectTitle && title !== screen.expectTitle
        ? [`title "${screen.expectTitle}" (found: "${title}")`]
        : []),
      ...(screen.expectAriaLabel && !ariaLabels.includes(screen.expectAriaLabel)
        ? [`aria-label "${screen.expectAriaLabel}"`]
        : []),
      ...(screen.expectFocus && !focused.includes(screen.expectFocus)
        ? [`focus on "${screen.expectFocus}" (focused: "${focused}")`]
        : []),
      ...(screen.expectEnabled && !enabledButtons.includes(screen.expectEnabled)
        ? [`enabled button "${screen.expectEnabled}"`]
        : []),
      ...(screen.rejectButton && buttonLabels.includes(screen.rejectButton)
        ? [`unexpected button "${screen.rejectButton}"`]
        : []),
      ...(screen.expectNeutralNote && !neutralNotes.includes(screen.expectNeutralNote)
        ? [`neutral connector note "${screen.expectNeutralNote}"`]
        : []),
      ...(screen.expectDotCount !== undefined && dotCount !== screen.expectDotCount
        ? [`${screen.expectDotCount} footer dots (found: ${dotCount})`]
        : []),
      ...(screen.expectBodyScrollTop !== undefined && bodyScrollTop !== screen.expectBodyScrollTop
        ? [`wizard body scroll ${screen.expectBodyScrollTop} (found: ${bodyScrollTop})`]
        : []),
    ];
    if (missing.length) failures += 1;
    console.log("SHOT:" + JSON.stringify({ screen: screen.name, out, missing }));
    await screen.after?.(win);
  }
  return failures;
}

/** Every one of these scripts fails the same way: loudly, with the reason. */
export function failLoudly() {
  process.on("unhandledRejection", (error) => {
    console.error("SHOT-FAILED:", error);
    app.exit(1);
  });
}
