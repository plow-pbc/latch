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

/** Each request for one piece of state takes the next number, and its answer
 * lands only if no newer request's answer landed first — so a slow read can't
 * overwrite what a later write answered. Every caller still gets its answer. */
export function latestOnly(land) {
  let asked = 0;
  let landed = 0;
  return async (request) => {
    const n = ++asked;
    const answer = await request();
    if (n > landed) {
      landed = n;
      land(answer);
    }
    return answer;
  };
}

/** For a request whose answer is read only when it finishes (a grant's act
 * runs its whole flow first): it takes its number from `show` on answering,
 * so a refresh asked while it ran is older. */
export const whenAnswered = (promise, show) => promise.then((answer) => show(() => answer));
