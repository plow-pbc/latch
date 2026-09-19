export function singleFlight(blocked) {
  let pending = false;
  return async (action) => {
    if (pending || blocked()) return;
    pending = true;
    try {
      return await action();
    } finally {
      pending = false;
    }
  };
}

/** Persist setup's navigation intent before starting a process relaunch. */
export async function relaunchAfterPreparingOnboarding(prepare, relaunch) {
  await prepare();
  await relaunch();
}

/** Only the newest request for one piece of state lands its answer: asking a
 * newer one retires every older snapshot, so a slow read can't paint over a
 * later write. Every caller still gets its answer. */
export function latestOnly(land) {
  let asked = 0;
  return async (request) => {
    const n = ++asked;
    const answer = await request();
    if (n === asked) land(answer);
    return answer;
  };
}

/** For a request whose answer is read only when it finishes (a grant's act
 * runs its whole flow first): it takes its number from `show` on answering,
 * so a refresh asked while it ran is older. */
export const whenAnswered = (promise, show) => promise.then((answer) => show(() => answer));
