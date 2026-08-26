import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConnectorClient } from "../src/connectorWiring.js";
import { loadSettings, saveSettings } from "../src/settings.js";

describe("connector wiring", () => {
  // A Plow API change forces every install to re-activate. The credential is
  // read per call, off disk, so the next tool call after a re-pair carries the
  // new one — a captured string would keep sending the dead credential until
  // the app was quit and relaunched, which reads as a server fault rather than
  // as a Mac that has not been re-paired.
  it("reads the credential off disk per call, so a re-pair needs no restart", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "latch-connector-"));
    try {
      const pair = (credential: string) =>
        saveSettings(home, { ...loadSettings(home), relayCredential: credential });
      const seen: string[] = [];
      const client = buildConnectorClient({
        apiBaseUrl: "https://api.example.com",
        home,
        fetchImpl: async (_url, init) => {
          seen.push((init?.headers as Record<string, string>).Authorization);
          return new Response("{}", { status: 200 });
        },
      });

      pair("first");
      await client.call("channels.list", {});
      pair("second");
      await client.call("channels.list", {});

      expect(seen).toEqual(["Bearer first", "Bearer second"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
