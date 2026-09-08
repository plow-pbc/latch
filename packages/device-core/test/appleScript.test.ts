import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppNotFoundError, resolveAppBundleId } from "@domo/device-core";

function fakeApp(folder: string, name: string, bundleId: string): void {
  const contents = path.join(folder, `${name}.app`, "Contents");
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(
    path.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`,
  );
}

describe("resolveAppBundleId", () => {
  it("reads the bundle id of <folder>/<name>.app, first folder wins", async () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "apps-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "apps-b-"));
    fakeApp(a, "Mail", "com.example.mail-a");
    fakeApp(b, "Mail", "com.example.mail-b");
    fakeApp(b, "Notes", "com.example.notes");
    expect(await resolveAppBundleId("Mail", [a, b])).toBe("com.example.mail-a");
    expect(await resolveAppBundleId("Notes", [a, b])).toBe("com.example.notes");
  });

  it("an unknown name is an AppNotFoundError naming it", async () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "apps-a-"));
    await expect(resolveAppBundleId("Ghost", [a])).rejects.toBeInstanceOf(AppNotFoundError);
    await expect(resolveAppBundleId("Ghost", [a])).rejects.toThrow('"Ghost"');
  });

  it("a name cannot walk out of the application folders", async () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "apps-a-"));
    await expect(resolveAppBundleId("../../../System/Applications/Mail", [a])).rejects.toBeInstanceOf(
      AppNotFoundError,
    );
  });

  it("finds the real system apps and the faceless scripting targets", async () => {
    expect(await resolveAppBundleId("Finder")).toBe("com.apple.finder");
    expect(await resolveAppBundleId("System Events")).toBe("com.apple.systemevents");
    expect(await resolveAppBundleId("Mail")).toBe("com.apple.mail");
  });
});
