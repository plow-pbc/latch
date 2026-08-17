import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against src directly; no build step needed.
    alias: {
      "@domo/protocol": p("packages/protocol/src/index.ts"),
      "@domo/transport": p("packages/transport/src/index.ts"),
      "@domo/device-core": p("packages/device-core/src/index.ts"),
      "@domo/mcp-server": p("packages/mcp-server/src/index.ts"),
      "@domo/relay-client": p("packages/relay-client/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
