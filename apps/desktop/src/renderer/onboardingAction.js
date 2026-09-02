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
