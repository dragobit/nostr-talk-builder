// Local-only config for the NIP-29 E2E harness (not part of npm test):
//   docker run -d -p 2929:8080 -e NIP29__relay__relay_url=ws://localhost:2929 \
//     -e NIP29__relay__auth_url=ws://localhost:2929 ghcr.io/verse-pbc/groups_relay
//   npx vitest run -c vitest.e2e.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.ts"],
    testTimeout: 60000,
    pool: "forks",
  },
});
