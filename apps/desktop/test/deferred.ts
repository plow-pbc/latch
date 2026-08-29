/**
 * A promise a test finishes by hand.
 *
 * For landing two reads out of order: hold the first open, let the second
 * complete, then finish the first and assert the newer answer survived. Both
 * cloud-agent and roster state guard that, and both were writing this out.
 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
