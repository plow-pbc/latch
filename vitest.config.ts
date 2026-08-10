import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against src directly; no build step needed.
    alias: {
      "@domo/protocol": p("packages/protocol/src/index.ts"),
      "@domo/transport": p("packages/transport/src/index.ts"),
      "@domo/broker-core": p("packages/broker-core/src/index.ts"),
      "@domo/device-core": p("packages/device-core/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "e2e/**/*.test.ts"],
    // E2E tests boot real processes; give them room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
