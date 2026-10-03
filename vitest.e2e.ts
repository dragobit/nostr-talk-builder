// Local-only E2E config (not part of npm test — the harnesses hit real
// services). Run manually with `npx vitest run -c vitest.e2e.ts`.
//   NIP-29 harness: docker run -d -p 2929:8080 -e NIP29__relay__relay_url=ws://localhost:2929 \
//     -e NIP29__relay__auth_url=ws://localhost:2929 ghcr.io/verse-pbc/groups_relay
//   Live-relay harness (e2e/*.e2e.ts): hits public relays such as nos.lol.
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["e2e/**/*.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
