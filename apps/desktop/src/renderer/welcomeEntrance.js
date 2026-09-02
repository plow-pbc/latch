export const FONT_WAIT_CEILING_MS = 800;

export async function startAfterDocumentPaint(start, options = {}) {
  const fontsReady = options.fontsReady ?? document.fonts.ready;
  const requestFrame = options.requestFrame ?? requestAnimationFrame;

  await Promise.race([
    fontsReady,
    new Promise((resolve) => setTimeout(resolve, FONT_WAIT_CEILING_MS)),
  ]);
  await new Promise((resolve) => {
    requestFrame(() => requestFrame(resolve));
  });
  start();
}
