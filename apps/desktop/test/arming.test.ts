/* The approval window's guard against accidental input: the window can take
   key focus while the human is typing in another app, so nothing may activate
   until the window has been quietly focused for the arming delay — and the
   press itself must have started after that. Keyboard arms later than mouse: a
   stray Return is exactly the keystroke the human was already making. Driven
   with a fake clock; the renderer supplies the real one. */

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS renderer module, shipped as-is (not compiled by tsc)
import { InputArming } from "../src/renderer/arming.js";

const MOUSE = 1000;
const KEY = 2000;

function make() {
  const clock = { t: 0 };
  const arming = new InputArming({ now: () => clock.t, mouseDelayMs: MOUSE, keyDelayMs: KEY });
  return { clock, arming };
}

describe("InputArming", () => {
  it("nothing activates before arm() is ever called", () => {
    const { arming } = make();
    arming.pressStarted("mouse");
    expect(arming.mayActivate()).toBe(false);
    arming.pressStarted("key");
    expect(arming.mayActivate()).toBe(false);
    expect(arming.remainingMs("mouse")).toBe(Infinity);
    expect(arming.remainingMs("key")).toBe(Infinity);
  });

  it("a press during that kind's quiet period does not activate", () => {
    const { clock, arming } = make();
    arming.arm();
    clock.t += MOUSE - 1;
    arming.pressStarted("mouse");
    expect(arming.mayActivate()).toBe(false);
    clock.t = KEY - 1;
    arming.pressStarted("key");
    expect(arming.mayActivate()).toBe(false);
  });

  it("a fresh press after that kind's delay activates", () => {
    const { clock, arming } = make();
    arming.arm();
    clock.t += MOUSE;
    arming.pressStarted("mouse");
    expect(arming.mayActivate()).toBe(true);
    clock.t = KEY;
    arming.pressStarted("key");
    expect(arming.mayActivate()).toBe(true);
  });

  it("keyboard stays dead in the window where mouse is already live", () => {
    const { clock, arming } = make();
    arming.arm();
    clock.t += KEY - 1; // mouse armed long ago; key one tick short
    arming.pressStarted("key");
    expect(arming.mayActivate()).toBe(false);
    arming.pressStarted("mouse");
    expect(arming.mayActivate()).toBe(true);
  });

  it("a key auto-repeat never activates, even when armed", () => {
    const { clock, arming } = make();
    arming.arm();
    clock.t += KEY;
    arming.pressStarted("key", { repeat: true });
    expect(arming.mayActivate()).toBe(false);
  });

  it("a press that started before arming stays dead after arming", () => {
    // Keydown lands in the quiet period (or came from the previous app);
    // the keyup/click arrives after the delay. Still no.
    const { clock, arming } = make();
    arming.arm();
    clock.t += 100;
    arming.pressStarted("key");
    clock.t += KEY;
    expect(arming.mayActivate()).toBe(false);
    // A brand-new press now is fine.
    arming.pressStarted("key");
    expect(arming.mayActivate()).toBe(true);
  });

  it("re-arming (focus regained) invalidates an in-flight press and restarts both delays", () => {
    const { clock, arming } = make();
    arming.arm();
    clock.t += KEY;
    arming.pressStarted("key");
    expect(arming.mayActivate()).toBe(true);
    arming.arm();
    expect(arming.mayActivate()).toBe(false);
    expect(arming.remainingMs("mouse")).toBe(MOUSE);
    clock.t += KEY;
    expect(arming.mayActivate()).toBe(false); // armed again, but that press is stale
    arming.pressStarted("key");
    expect(arming.mayActivate()).toBe(true);
  });

  it("disarm (focus lost) blocks everything until re-armed", () => {
    const { clock, arming } = make();
    arming.arm();
    clock.t += KEY;
    arming.pressStarted("mouse");
    arming.disarm();
    expect(arming.mayActivate()).toBe(false);
    expect(arming.isArmed("mouse")).toBe(false);
    expect(arming.remainingMs("key")).toBe(Infinity);
    arming.arm();
    clock.t += MOUSE;
    arming.pressStarted("mouse");
    expect(arming.mayActivate()).toBe(true);
  });

  it("remainingMs counts down per kind, for scheduling enable and focus moments", () => {
    const { clock, arming } = make();
    arming.arm();
    expect(arming.remainingMs("mouse")).toBe(MOUSE);
    expect(arming.remainingMs("key")).toBe(KEY);
    clock.t += MOUSE;
    expect(arming.remainingMs("mouse")).toBe(0);
    expect(arming.remainingMs("key")).toBe(KEY - MOUSE);
    expect(arming.isArmed("mouse")).toBe(true);
    expect(arming.isArmed("key")).toBe(false);
    clock.t += KEY - MOUSE;
    expect(arming.remainingMs("key")).toBe(0);
    expect(arming.isArmed("key")).toBe(true);
  });
});
