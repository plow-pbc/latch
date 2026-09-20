const MODES = {
  adversarial: {
    mode: "adversarial",
    label: "Enabled",
    description: "Requests not already allowed by a rule or the Plow workspace go to the AI Reviewer.",
  },
  ask: {
    mode: "ask",
    label: "Ask every time",
    description: "Requests not already allowed by a rule or the Plow workspace open an approval window.",
  },
  approve: {
    mode: "approve",
    label: "Approve everything",
    description: "Every request runs without review.",
  },
  deny: {
    mode: "deny",
    label: "Deny everything",
    description: "Every request is refused.",
  },
};

export function modeView(mode) {
  return MODES[mode] ?? MODES.ask;
}

export function attentionMatches(attention, activity) {
  return !!attention && !!activity &&
    attention.intentId === activity.intentId && activity.decisionKind === "denied";
}

export function createSerialAutosave(save, delayMs = 500, initialValue = "") {
  let current = { phase: "idle", draft: initialValue, stored: initialValue, error: null };
  let timer = null;
  let running = null;
  let disposed = false;
  const subscribers = new Set();

  const publish = (patch) => {
    current = { ...current, ...patch };
    for (const subscriber of subscribers) subscriber({ ...current });
  };

  const drain = () => {
    if (running) return running;
    running = (async () => {
      while (!disposed && current.draft !== current.stored) {
        const target = current.draft;
        publish({ phase: "saving", error: null });
        try {
          const stored = await save(target);
          if (current.draft === target) {
            publish({ phase: "saved", draft: stored, stored, error: null });
          } else {
            publish({ phase: "idle", stored, error: null });
          }
        } catch (error) {
          if (current.draft === target) {
            publish({ phase: "error", error });
            break;
          }
        }
      }
    })().finally(() => { running = null; });
    return running;
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, delayMs);
  };

  return {
    edit(value) {
      if (disposed) return;
      publish({ phase: "idle", draft: value, error: null });
      schedule();
    },
    async flush() {
      const hadTimer = timer !== null;
      clearTimeout(timer);
      timer = null;
      if (hadTimer && current.phase !== "error") await drain();
      if (running) await running;
      while (current.phase !== "error" && current.draft !== current.stored) await drain();
      return { ...current };
    },
    retry() {
      if (disposed || current.phase !== "error") return;
      publish({ phase: "idle", error: null });
      void drain();
    },
    state() {
      return { ...current };
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = null;
      subscribers.clear();
    },
  };
}
