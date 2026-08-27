import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const rendererMain = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/renderer/main.js",
);

it("renders failed cloud agents as terminal red with a useful reason", () => {
  const source = fs.readFileSync(rendererMain, "utf8");
  const body = source.match(
    /function cloudStatus\(status, failureReason\) \{([\s\S]*?)\n\}/,
  )?.[1];
  expect(body).toBeDefined();
  const cloudStatus = new Function("status", "failureReason", body!) as (
    status: string,
    failureReason: string | null,
  ) => { tone: string; label: string };

  expect(cloudStatus("failed", "provider_unreachable")).toMatchObject({
    tone: "red",
    label: expect.stringMatching(/provider.*unreachable/i),
  });
  expect(cloudStatus("failed", "validation_failed").label).toMatch(/retrying will not help.*human/i);
  expect(cloudStatus("failed", "capacity_exhausted")).toMatchObject({
    tone: "red",
    label: expect.stringContaining("capacity_exhausted"),
  });
  expect(cloudStatus("failed", "toString")).toEqual({
    tone: "red",
    label: "Failed · toString",
  });
});
