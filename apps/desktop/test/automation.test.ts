/**
 * Automation consent, per app. The real probe sends a gated Apple event via
 * osascript; doing that in a test would prompt whoever runs the suite, so the
 * runner is injected and these exercise the classification, the memo, and
 * the app guard. Carried over from the apple-events branch with the vocabulary
 * widened to the host-gate helper's (`not_asked`, `target_not_running`).
 */
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_APPS,
  automationApp,
  classifyProbe,
  reconcile,
  requestAutomation,
} from "../src/automation.js";

describe("classifyProbe", () => {
  it("a clean exit is a grant", () => {
    expect(classifyProbe({ exitCode: 0, stderr: "" })).toBe("granted");
  });
  it("-1743 / Not authorized is macOS saying no", () => {
    expect(classifyProbe({ exitCode: 1, stderr: "execution error: Not authorized to send Apple events to Mail. (-1743)" })).toBe("denied");
    expect(classifyProbe({ exitCode: 1, stderr: "... (-1743)" })).toBe("denied");
  });
  it("an app-level error past the gate still counts as granted", () => {
    // The event reached the app (some other error), so permission was not the
    // obstacle — e.g. an app with no `windows` element.
    expect(classifyProbe({ exitCode: 1, stderr: "execution error: Finder got an error: can't get windows. (-1728)" })).toBe("granted");
  });
  it("a dialog dismissed without an answer is still not asked", () => {
    expect(classifyProbe({ exitCode: 1, stderr: "execution error: consent required (-1744)" })).toBe("not_asked");
  });
  it("a probe that never reached the gate is unknown", () => {
    expect(classifyProbe({ exitCode: -1, stderr: "" })).toBe("unknown");
  });
});

describe("requestAutomation", () => {
  it("runs the probe only for apps the tab offers", async () => {
    const asked: string[] = [];
    const run = async (id: string) => {
      asked.push(id);
      return { exitCode: 0, stderr: "" };
    };
    expect(await requestAutomation("com.evil.thing", run)).toBe("unknown");
    expect(asked).toEqual([]);
    expect(await requestAutomation("com.apple.mail", run)).toBe("granted");
    expect(asked).toEqual(["com.apple.mail"]);
  });

  it("offers the apps agents are most asked to drive, Messages first, no duplicate bundle ids", () => {
    expect(AUTOMATION_APPS[0]!.name).toBe("Messages");
    expect(AUTOMATION_APPS.map((a) => a.name)).toEqual(expect.arrayContaining(["Mail", "Contacts", "Calendar"]));
    expect(new Set(AUTOMATION_APPS.map((a) => a.bundleId)).size).toBe(AUTOMATION_APPS.length);
  });

  it("finds an offered app by name or bundle id, case-insensitively", () => {
    expect(automationApp("messages")?.bundleId).toBe("com.apple.MobileSMS");
    expect(automationApp("com.apple.mail")?.name).toBe("Mail");
    expect(automationApp("Xcode")).toBeNull();
  });
});

describe("reconcile", () => {
  it("a conclusive read overwrites the memo — a revoked app goes (and stays) denied", () => {
    const r = reconcile("denied", "granted");
    expect(r).toEqual({ status: "denied", memo: "denied", changed: true });
  });
  it("a reset pair goes back to not asked", () => {
    expect(reconcile("not_asked", "granted")).toEqual({ status: "not_asked", memo: "not_asked", changed: true });
  });
  it("an inconclusive read (a quit app) keeps the remembered value", () => {
    expect(reconcile("target_not_running", "granted")).toEqual({ status: "granted", memo: "granted", changed: false });
  });
  it("a first, never-decided app with no memo reads as what macOS said", () => {
    expect(reconcile("target_not_running", undefined)).toEqual({ status: "target_not_running", memo: undefined, changed: false });
    expect(reconcile("unknown", undefined).status).toBe("unknown");
  });
  it("re-confirming an already-granted app is no change", () => {
    expect(reconcile("granted", "granted").changed).toBe(false);
  });
});
