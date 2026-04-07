/**
 * Unit tests for src/middleware/api-key.ts
 *
 * Tests API key authentication middleware behaviour without any Azure dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

describe("apiKeyAuth middleware", () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.MCP_API_KEY;
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

    // X-API-Key is correct, Authorization is wrong — should pass
    const res = await request(app)
      .post("/mcp")
      .set("X-API-Key", "correct-key")
      .set("Authorization", "Bearer wrong-key")
      .send({ test: true })
      .expect(200);

    expect(res.body.ok).toBe(true);
  });
});
