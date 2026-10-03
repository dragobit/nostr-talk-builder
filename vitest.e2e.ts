import path from "node:path";
import { defineConfig } from "vitest/config";

// Live-relay end-to-end tests. Excluded from `npm test` on purpose (they hit
// public relays); run manually with `npx vitest run -c vitest.e2e.ts`.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
