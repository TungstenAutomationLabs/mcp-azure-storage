import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for integration tests.
 *
 * These tests require Azurite running:
 *   docker compose -f docker-compose.azurite.yml up -d
 *
 * Run with:
 *   npm run test:integration
 *
 * ── Environment-variable gates ───────────────────────────────────────────────
 *
 * | Variable            | Default | Purpose                                  |
 * |---------------------|---------|------------------------------------------|
 * | TEST_INTEGRATION    | 0       | Master gate — must be 1 for any test to  |
 * |                     |         | run. `npm run test:integration` sets it.  |
 * | TEST_UPLOAD_LARGE   | 0       | Enable 150+ MiB streaming upload tests.  |
 * | TEST_AZURE_LIVE     | 0       | Enable live-Azure-dependent tests (also  |
 * |                     |         | implicitly enables large upload tests).   |
 * | TEST_UPLOAD_MB      | 150     | Payload size (MiB) for large upload test. |
 *
 * Each test file applies its own skip logic (e.g. `describe.skipIf(SKIP)`)
 * using these env vars. The config below simply discovers the test files;
 * gating is intentionally left to the test files themselves so that each
 * suite can express its own preconditions.
 *
 * ── Azurite notes ────────────────────────────────────────────────────────────
 *
 * - Set `SAS_PROTOCOL=https,http` when testing SAS operations against Azurite
 *   (Azurite only serves HTTP; the default `https` causes SAS validation errors).
 * - Endpoint overrides in `.env.test`:
 *     AZURE_BLOB_SERVICE_URL=http://127.0.0.1:10000/devstoreaccount1
 *     AZURE_QUEUE_SERVICE_URL=http://127.0.0.1:10001/devstoreaccount1
 *     AZURE_TABLE_SERVICE_URL=http://127.0.0.1:10002/devstoreaccount1
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
