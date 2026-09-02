export async function startAfterDocumentPaint(start, options = {}) {
  const fontsReady = options.fontsReady ?? document.fonts.ready;
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const scheduleTask = options.scheduleTask ?? ((callback, delay = 0) => setTimeout(callback, delay));

  await Promise.race([
    fontsReady.catch(() => {}),
    new Promise((resolve) => scheduleTask(() => resolve(), 800)),
  ]);
  // Crossing from a frame callback through a task gives the browser a chance
  // to paint; re-entering on the next frame starts the clock at that boundary.
  await new Promise((resolve) => {
    requestFrame(() => scheduleTask(() => resolve()));
  });
  await new Promise((resolve) => requestFrame(() => resolve()));
  start();
}
