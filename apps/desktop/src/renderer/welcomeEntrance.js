export async function startAfterDocumentPaint(start, options = {}) {
  const fontsReady = options.fontsReady ?? document.fonts.ready;
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const scheduleTask = options.scheduleTask ?? ((callback) => setTimeout(callback, 0));

  await fontsReady;
  // Crossing from a frame callback through a task gives the browser a chance
  // to paint; re-entering on the next frame starts the clock at that boundary.
  await new Promise((resolve) => {
    requestFrame(() => scheduleTask(() => resolve()));
  });
  await new Promise((resolve) => requestFrame(() => resolve()));
  start();
}
