/**
 * One vault write section at a time. The hourly 1Password pass and the owner's
 * own import commits and saves each reconcile against the live vault and then
 * write; interleaved, two "this is new" verdicts for one login could both
 * create. Each section starts when the one before it ends, whether it threw.
 */
export function serialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
