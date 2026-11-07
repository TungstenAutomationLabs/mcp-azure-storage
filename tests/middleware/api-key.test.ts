/**
 * Unit tests for src/middleware/api-key.ts
 *
 * Tests API key authentication middleware behaviour without any Azure dependencies.
 * Verifies that request logging uses the OTel logger (not raw console.log) and
 * that no actual key values or tokens are leaked in log output.
 */

import express from "express";
import request from "supertest";

// Mock the OTel logger module so we can inspect calls without side-effects.
const mockDebug = vi.fn();
const mockWarn = vi.fn();
const mockError = vi.fn();

vi.mock("../../src/utils/otel-logger.js", () => ({
  debug: mockDebug,
  warn: mockWarn,
  error: mockError,
  info: vi.fn(),
}));

describe("apiKeyAuth middleware", () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.MCP_API_KEY;
    mockDebug.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(() => {
    // Restore original env
    if (originalApiKey !== undefined) {
      process.env.MCP_API_KEY = originalApiKey;
    } else {
      delete process.env.MCP_API_KEY;
    }
    vi.resetModules();
  });

  async function createApp() {
    // Dynamic import to pick up current env
    const { apiKeyAuth } = await import("../../src/middleware/api-key.js");
    const app = express();
    app.use(express.json());
    app.use("/mcp", apiKeyAuth);
    app.post("/mcp", (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  it("returns 503 when MCP_API_KEY is not configured", async () => {
    delete process.env.MCP_API_KEY;
    const app = await createApp();

    const res = await request(app)
      .post("/mcp")
      .send({ test: true })
      .expect(503);

    expect(res.body.error.code).toBe(-32001);
    expect(res.body.error.message).toContain("misconfigured");
  });

  it("returns 401 when no API key is provided in request", async () => {
    process.env.MCP_API_KEY = "test-key-abc";
    const app = await createApp();

    const res = await request(app)
      .post("/mcp")
      .send({ test: true })
      .expect(401);

    expect(res.body.error.code).toBe(-32001);
    expect(res.body.error.message).toContain("Missing API key");
  });

  it("returns 403 when X-API-Key header has wrong value", async () => {
    process.env.MCP_API_KEY = "correct-key";
    const app = await createApp();

    const res = await request(app)
      .post("/mcp")
      .set("X-API-Key", "wrong-key")
      .send({ test: true })
      .expect(403);

    expect(res.body.error.code).toBe(-32002);
    expect(res.body.error.message).toContain("Invalid API key");
  });

  it("passes through when X-API-Key header matches", async () => {
    process.env.MCP_API_KEY = "correct-key";
    const app = await createApp();

    const res = await request(app)
      .post("/mcp")
      .set("X-API-Key", "correct-key")
      .send({ test: true })
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it("passes through when Authorization: Bearer header matches", async () => {
    process.env.MCP_API_KEY = "bearer-test-key";
    const app = await createApp();

    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer bearer-test-key")
      .send({ test: true })
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it("returns 403 when Bearer token is wrong", async () => {
    process.env.MCP_API_KEY = "correct-key";
    const app = await createApp();

    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer incorrect-key")
      .send({ test: true })
      .expect(403);

    expect(res.body.error.code).toBe(-32002);
  });

  it("prefers X-API-Key over Authorization header", async () => {
    process.env.MCP_API_KEY = "correct-key";
    const app = await createApp();

    // X-API-Key is correct, Authorization is wrong -- should pass
    const res = await request(app)
      .post("/mcp")
      .set("X-API-Key", "correct-key")
      .set("Authorization", "Bearer wrong-key")
      .send({ test: true })
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  describe("OTel debug logging", () => {
    it("emits request log via OTel debug(), not raw console.log", async () => {
      process.env.MCP_API_KEY = "correct-key";
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const app = await createApp();

      await request(app)
        .post("/mcp")
        .set("X-API-Key", "correct-key")
        .send({ test: true })
        .expect(200);

      // The OTel debug function should have been called
      expect(mockDebug).toHaveBeenCalledTimes(1);
      expect(mockDebug).toHaveBeenCalledWith(
        expect.stringContaining("POST"),
        expect.objectContaining({
          component: "auth",
          xApiKey: "present",
          authorization: "missing",
        }),
      );

      // Raw console.log should NOT have been called directly by the middleware
      // (the mock replaces the otel-logger module, so no console.log pass-through)
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("logs only 'present'/'missing' indicators, never actual key values", async () => {
      const secretKey = "super-secret-key-12345";
      const secretBearer = "Bearer top-secret-token-67890";
      process.env.MCP_API_KEY = secretKey;
      const app = await createApp();

      await request(app)
        .post("/mcp")
        .set("X-API-Key", secretKey)
        .set("Authorization", secretBearer)
        .send({ test: true })
        .expect(200);

      // Inspect every argument passed to debug()
      const debugArgs = JSON.stringify(mockDebug.mock.calls);
      expect(debugArgs).not.toContain(secretKey);
      expect(debugArgs).not.toContain("top-secret-token-67890");

      // The attributes should contain only safe indicator values
      const attrs = mockDebug.mock.calls[0][1];
      expect(attrs.xApiKey).toBe("present");
      expect(attrs.authorization).toBe("present");
    });

    it("emits warn() when request has no API key", async () => {
      process.env.MCP_API_KEY = "test-key";
      const app = await createApp();

      await request(app)
        .post("/mcp")
        .send({ test: true })
        .expect(401);

      // debug() called for the request log, warn() for the rejection
      expect(mockDebug).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining("no API key"),
        expect.objectContaining({ component: "auth" }),
      );
    });

    it("emits warn() when API key is invalid", async () => {
      process.env.MCP_API_KEY = "correct-key";
      const app = await createApp();

      await request(app)
        .post("/mcp")
        .set("X-API-Key", "wrong-key")
        .send({ test: true })
        .expect(403);

      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining("invalid API key"),
        expect.objectContaining({ component: "auth" }),
      );

      // Ensure the actual key values are not in the warn() output
      const warnArgs = JSON.stringify(mockWarn.mock.calls);
      expect(warnArgs).not.toContain("correct-key");
      expect(warnArgs).not.toContain("wrong-key");
    });

    it("emits error() when MCP_API_KEY env var is not set", async () => {
      delete process.env.MCP_API_KEY;
      const app = await createApp();

      await request(app)
        .post("/mcp")
        .send({ test: true })
        .expect(503);

      expect(mockError).toHaveBeenCalledTimes(1);
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining("MCP_API_KEY not set"),
        expect.objectContaining({ component: "auth" }),
      );
    });
  });
});
