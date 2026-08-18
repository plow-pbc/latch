/* Input arming for the approval window.

   The window can appear (and take key focus) while the human is typing in
   another app, so the first Return/Space/click after it shows may be aimed at
   something else entirely — and the default-focused button is "Allow Once".
   Chrome's permission bubbles guard against exactly this
   (InputEventActivationProtector); this is the same idea, kept pure so vitest
   can drive it with a fake clock.

   Keyboard arms later than mouse: a click requires aiming at a button that
   just appeared, but a stray Return is exactly the keystroke the human was
   already making, so it gets the longer quiet period.

   The rule has two halves, and both are needed:

   - **Armed only after a quiet delay (per input kind).** Arming starts when
     the window is shown and restarts every time it gains focus; nothing
     activates until that kind's delay has fully elapsed. The renderer also
     disables the buttons until then, but the disabled attribute alone can't
     express the second half:
   - **The press must have STARTED while armed.** A keydown in the previous app
     whose keyup lands here, or a held key auto-repeating into this window,
     began before the human could have read the prompt. So activation is judged
     at press-start time (keydown/mousedown), not at click time, and key
     repeats never qualify.

   Purely a state machine over an injected clock: no timers, no DOM. The
   renderer feeds it show/focus/blur and press events and consults
   `mayActivate()` in its click handlers. */

/** @typedef {"mouse" | "key"} PressKind */

export class InputArming {
  /**
   * @param {{ now: () => number, mouseDelayMs?: number, keyDelayMs?: number }}
   *   opts — `now` is the clock (milliseconds, any epoch); the delays are the
   *   quiet periods per input kind.
   */
  constructor({ now, mouseDelayMs = 1000, keyDelayMs = 2000 }) {
    this.now = now;
    this.delayMs = { mouse: mouseDelayMs, key: keyDelayMs };
    // Not armed until the window reports itself shown/focused.
    this.armedAt = { mouse: Infinity, key: Infinity };
    this.pressValid = false;
    /** @type {PressKind | null} */
    this.pressKind = null;
  }

  /** The window was shown or gained focus: restart both quiet periods. Any
   *  press already in flight predates the (re)gained attention, so it is
   *  invalidated too. */
  arm() {
    const t = this.now();
    this.armedAt = { mouse: t + this.delayMs.mouse, key: t + this.delayMs.key };
    this.pressValid = false;
    this.pressKind = null;
  }

  /** The window lost focus: nothing may activate until it is re-armed. */
  disarm() {
    this.armedAt = { mouse: Infinity, key: Infinity };
    this.pressValid = false;
    this.pressKind = null;
  }

  /** @param {PressKind} kind
   *  @returns {boolean} whether that kind's quiet period has fully elapsed. */
  isArmed(kind) {
    return this.now() >= this.armedAt[kind];
  }

  /** Milliseconds until `kind` is armed — 0 when already armed, Infinity when
   *  disarmed. The renderer schedules its button-enable moment (mouse) and its
   *  default-focus moment (key) from this.
   *  @param {PressKind} kind */
  remainingMs(kind) {
    return Math.max(0, this.armedAt[kind] - this.now());
  }

  /**
   * A press began: keydown or mousedown, capture phase, before any click
   * handler runs. `repeat` is KeyboardEvent.repeat — an auto-repeat means the
   * key was physically pressed some time ago, possibly in another app.
   * @param {PressKind} kind
   * @param {{ repeat?: boolean }} [opts]
   */
  pressStarted(kind, { repeat = false } = {}) {
    this.pressKind = kind;
    this.pressValid = this.isArmed(kind) && !repeat;
  }

  /** Consulted by click handlers: fire only if the most recent press began
   *  while its kind was armed, and that kind is still armed now. */
  mayActivate() {
    return this.pressKind !== null && this.pressValid && this.isArmed(this.pressKind);
  }
}
