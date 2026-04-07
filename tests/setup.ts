/**
 * Vitest global setup — runs before every test file.
 *
 * Sets safe, deterministic environment variables so that src/config.ts
 * and src/middleware/api-key.ts don't throw during unit tests.
 * These are dummy values — unit tests mock the Azure SDK clients anyway.
 */

// Provide dummy credentials so getStorageConfig() succeeds
process.env.AZURE_STORAGE_ACCOUNT_NAME =
  process.env.AZURE_STORAGE_ACCOUNT_NAME || "devstoreaccount1";
process.env.AZURE_STORAGE_ACCOUNT_KEY =
  process.env.AZURE_STORAGE_ACCOUNT_KEY ||
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

// Provide a test API key for middleware tests
process.env.MCP_API_KEY = process.env.MCP_API_KEY || "test-api-key-12345";

// Cap sessions low for unit tests
process.env.MAX_SESSIONS = process.env.MAX_SESSIONS || "5";
