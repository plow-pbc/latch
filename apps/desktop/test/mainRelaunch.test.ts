import vm from "node:vm";
import { expect, it } from "vitest";
import { compileMain, mainHandler } from "./mainSource.js";

// Exercise the shipping handler without booting Electron.
const compiled = compileMain(mainHandler("app:relaunch"));

it("relaunches without arming anything — setup checkpoints itself", () => {
  const calls: string[] = [];
  let handler!: () => void;
  // No `onboarding` in this context: if the handler ever reaches for it
  // again, calling it below throws "onboarding is not defined".
  vm.runInNewContext(compiled, {
    ipcMain: { handle: (_channel: string, fn: typeof handler) => { handler = fn; } },
    app: {
      relaunch: () => calls.push("relaunch"),
      quit: () => calls.push("quit"),
    },
  });

  handler();

  expect(calls).toEqual(["relaunch", "quit"]);
});
