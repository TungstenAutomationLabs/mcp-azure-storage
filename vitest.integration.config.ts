import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for integration tests.
 * These tests require Azurite running (docker compose -f docker-compose.azurite.yml up -d)
 * and are gated by TEST_INTEGRATION=1.
 *
 * Run with: npm run test:integration
 */
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
