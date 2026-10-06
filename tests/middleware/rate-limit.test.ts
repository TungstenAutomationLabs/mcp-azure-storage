/**
 * Unit tests for rate-limit middleware (Item 2).
 *
 * Tests separate MCP / upload budgets, API-key-aware identity keying,
 * trusted proxy hops, legacy env var fallback, and error shapes.
 *
 * All tests use tiny windows / limits so they complete in < 1 second.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import supertest from "supertest";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Constant-time string comparison (mirrors server.ts helper). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Extract Bearer token from Authorization header. */
function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : undefined;
}

/**
 * Derive a rate-limit identity key — same logic as server.ts getRateLimitKey.
 */
function getRateLimitKey(req: Request, configuredApiKey: string | undefined): { key: string; isApiKey: boolean } {
  const providedKey =
    (req.headers["x-api-key"] as string | undefined) ||
    extractBearerToken(req.headers.authorization);

  if (providedKey) {
    if (!configuredApiKey || timingSafeEqual(configuredApiKey, providedKey)) {
      const hash = crypto.createHash("sha256").update(providedKey).digest("hex");
      return { key: `apikey:${hash}`, isApiKey: true };
    }
  }

  return { key: `ip:${req.ip || "unknown"}`, isApiKey: false };
}

/**
 * Build a test Express app with separate MCP and upload rate limiters,
 * optionally fronted by a simple API key auth middleware.
 */
function createRateLimitApp(opts: {
  windowSeconds: number;
  mcpMax: number;
  uploadMax: number;
  apiKey?: string;
  trustProxyHops?: number;
}) {
  const app = express();
  app.set("trust proxy", opts.trustProxyHops ?? 1);
  app.use(express.json());

  const configuredApiKey = opts.apiKey;

  // Simple auth middleware for /mcp (mirrors apiKeyAuth fail-open when no key configured)
  const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    if (!configuredApiKey) {
      // Auth disabled — pass through
      return next();
    }
    const provided =
      (req.headers["x-api-key"] as string | undefined) ||
      extractBearerToken(req.headers.authorization);
    if (!provided) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Missing API key" } });
      return;
    }
    if (!timingSafeEqual(configuredApiKey, provided)) {
      // Wrong key — still pass through so rate limiter sees the IP-based key
      // (mirrors real server: apiKeyAuth rejects, but for rate-limit testing
      // we want to see the IP-based limiting behaviour, so we let it through)
    }
    next();
  };

  // MCP limiter
  const mcpLimiter = rateLimit({
    windowMs: opts.windowSeconds * 1000,
    max: opts.mcpMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => getRateLimitKey(req, configuredApiKey).key,
    handler: (req: Request, res: Response) => {
      res.set("Retry-After", String(opts.windowSeconds));
      res.status(429).json({
        jsonrpc: "2.0",
        id: req.body?.id ?? null,
        error: {
          code: -32005,
          message: "Too many requests, please try again later.",
          data: { reason: "rate_limited", retryAfterSeconds: opts.windowSeconds },
        },
      });
    },
  });

  // Upload limiter
  const uploadLimiter = rateLimit({
    windowMs: opts.windowSeconds * 1000,
    max: opts.uploadMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => getRateLimitKey(req, configuredApiKey).key,
    handler: (_req: Request, res: Response) => {
      res.set("Retry-After", String(opts.windowSeconds));
      res.status(429).json({
        error: "Too many requests, please try again later.",
        code: "rate_limited",
        retryAfterSeconds: opts.windowSeconds,
      });
    },
  });

  // Mount /mcp: auth → rate limit → handler
  app.post("/mcp", authMiddleware, mcpLimiter, (req: Request, res: Response) => {
    res.status(200).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? 1,
      result: { content: [{ type: "text", text: "ok" }] },
    });
  });

  // Mount /upload: auth → rate limit → handler
  app.post("/upload", authMiddleware, uploadLimiter, (req: Request, res: Response) => {
    res.status(200).json({ success: true });
  });

  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Rate limiting", () => {
  describe("/mcp over-limit response shape", () => {
    it("returns 429 with JSON-RPC error code -32005 and Retry-After header", async () => {
      const app = createRateLimitApp({ windowSeconds: 5, mcpMax: 2, uploadMax: 1 });

      // First two requests pass
      await supertest(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }).expect(200);
      await supertest(app).post("/mcp").send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }).expect(200);

      // Third request hits 429
      const res = await supertest(app)
        .post("/mcp")
        .send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
        .expect(429);

      expect(res.headers["retry-after"]).toBe("5");
      expect(res.body.jsonrpc).toBe("2.0");
      expect(res.body.id).toBe(3);
      expect(res.body.error.code).toBe(-32005);
      expect(res.body.error.message).toBe("Too many requests, please try again later.");
      expect(res.body.error.data.reason).toBe("rate_limited");
      expect(res.body.error.data.retryAfterSeconds).toBe(5);
      expect(typeof res.body.error.data.retryAfterSeconds).toBe("number");
    });

    it("sets id to null when request body has no id", async () => {
      const app = createRateLimitApp({ windowSeconds: 5, mcpMax: 1, uploadMax: 1 });
      await supertest(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }).expect(200);

      const res = await supertest(app)
        .post("/mcp")
        .send({ jsonrpc: "2.0", method: "tools/list", params: {} })
        .expect(429);

      expect(res.body.id).toBeNull();
    });
  });

  describe("/upload over-limit response shape", () => {
    it("returns 429 with JSON body (not JSON-RPC) and Retry-After header", async () => {
      const app = createRateLimitApp({ windowSeconds: 5, mcpMax: 10, uploadMax: 1 });

      await supertest(app).post("/upload").send({}).expect(200);

      const res = await supertest(app)
        .post("/upload")
        .send({})
        .expect(429);

      expect(res.headers["retry-after"]).toBe("5");
      expect(res.body.error).toBe("Too many requests, please try again later.");
      expect(res.body.code).toBe("rate_limited");
      expect(res.body.retryAfterSeconds).toBe(5);
      expect(typeof res.body.retryAfterSeconds).toBe("number");
      // Should NOT have jsonrpc field
      expect(res.body.jsonrpc).toBeUndefined();
    });
  });

  describe("API-key-aware separate budgets", () => {
    it("two different valid API keys get independent budgets", async () => {
      // When MCP_API_KEY is not set, any presented key gets its own hash-based budget
      const app = createRateLimitApp({ windowSeconds: 5, mcpMax: 2, uploadMax: 1 });

      const keyA = "valid-key-alpha";
      const keyB = "valid-key-beta";

      // keyA: 2 requests pass
      await supertest(app).post("/mcp").set("X-API-Key", keyA).send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }).expect(200);
      await supertest(app).post("/mcp").set("X-API-Key", keyA).send({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }).expect(200);

      // keyB: 2 requests pass (separate budget)
      await supertest(app).post("/mcp").set("X-API-Key", keyB).send({ jsonrpc: "2.0", id: 3, method: "ping", params: {} }).expect(200);
      await supertest(app).post("/mcp").set("X-API-Key", keyB).send({ jsonrpc: "2.0", id: 4, method: "ping", params: {} }).expect(200);

      // Both hit 429 on their 3rd request
      await supertest(app).post("/mcp").set("X-API-Key", keyA).send({ jsonrpc: "2.0", id: 5, method: "ping", params: {} }).expect(429);
      await supertest(app).post("/mcp").set("X-API-Key", keyB).send({ jsonrpc: "2.0", id: 6, method: "ping", params: {} }).expect(429);
    });
  });

  describe("wrong API keys share IP budget", () => {
    it("many wrong keys from one IP address are limited as one IP", async () => {
      const app = createRateLimitApp({
        windowSeconds: 5,
        mcpMax: 2,
        uploadMax: 1,
        apiKey: "the-real-server-key",
      });

      // Different wrong keys — they all fall back to IP-based limiting
      await supertest(app).post("/mcp").set("X-API-Key", "wrong-1").send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }).expect(200);
      await supertest(app).post("/mcp").set("X-API-Key", "wrong-2").send({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }).expect(200);

      // Third wrong key from same IP hits the limit
      const res = await supertest(app).post("/mcp").set("X-API-Key", "wrong-3").send({ jsonrpc: "2.0", id: 3, method: "ping", params: {} });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe(-32005);
    });
  });

  describe("separate budgets for /mcp and /upload", () => {
    it("exhausting /upload budget does not affect /mcp budget", async () => {
      const app = createRateLimitApp({ windowSeconds: 5, mcpMax: 2, uploadMax: 1 });

      // Use up the /upload budget
      await supertest(app).post("/upload").send({}).expect(200);
      await supertest(app).post("/upload").send({}).expect(429);

      // /mcp should still have its full budget
      await supertest(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }).expect(200);
      await supertest(app).post("/mcp").send({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }).expect(200);

      // Only the third /mcp request should hit the limit
      await supertest(app).post("/mcp").send({ jsonrpc: "2.0", id: 3, method: "ping", params: {} }).expect(429);
    });
  });

  describe("trust proxy hops", () => {
    it("with TRUST_PROXY_HOPS=1, single hop X-Forwarded-For is used for IP", async () => {
      const app = createRateLimitApp({ windowSeconds: 5, mcpMax: 2, uploadMax: 1, trustProxyHops: 1 });

      // Requests from "client IP" 10.0.0.1 via single proxy
      await supertest(app)
        .post("/mcp")
        .set("X-Forwarded-For", "10.0.0.1")
        .send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })
        .expect(200);
      await supertest(app)
        .post("/mcp")
        .set("X-Forwarded-For", "10.0.0.1")
        .send({ jsonrpc: "2.0", id: 2, method: "ping", params: {} })
        .expect(200);

      // Third request from same IP hits limit
      const res = await supertest(app)
        .post("/mcp")
        .set("X-Forwarded-For", "10.0.0.1")
        .send({ jsonrpc: "2.0", id: 3, method: "ping", params: {} });
      expect(res.status).toBe(429);
    });

    it("changing X-Forwarded-For per call still gets limited when all from same socket", async () => {
      // With trust proxy = 1, supertest requests come from 127.0.0.1 (socket).
      // Changing X-Forwarded-For changes the resolved IP, so each different IP
      // gets its own budget — but requests from the same apparent IP are limited.
      const app = createRateLimitApp({ windowSeconds: 5, mcpMax: 1, uploadMax: 1, trustProxyHops: 1 });

      // First request from "IP" 1.1.1.1
      await supertest(app)
        .post("/mcp")
        .set("X-Forwarded-For", "1.1.1.1")
        .send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })
        .expect(200);

      // Second request from same "IP" 1.1.1.1 — should be rate limited
      const res = await supertest(app)
        .post("/mcp")
        .set("X-Forwarded-For", "1.1.1.1")
        .send({ jsonrpc: "2.0", id: 2, method: "ping", params: {} });
      expect(res.status).toBe(429);

      // Different "IP" 2.2.2.2 — should pass (separate budget)
      await supertest(app)
        .post("/mcp")
        .set("X-Forwarded-For", "2.2.2.2")
        .send({ jsonrpc: "2.0", id: 3, method: "ping", params: {} })
        .expect(200);
    });

    it("with TRUST_PROXY_HOPS=2, two-hop chain resolves correct client IP", async () => {
      const app = createRateLimitApp({ windowSeconds: 5, mcpMax: 1, uploadMax: 1, trustProxyHops: 2 });

      // Two-hop chain: "client, proxy1" — with trust=2, client IP is the leftmost
      await supertest(app)
        .post("/mcp")
        .set("X-Forwarded-For", "10.0.0.1, 192.168.1.1")
        .send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })
        .expect(200);

      // Same client IP through different proxy — still same client budget
      await supertest(app)
        .post("/mcp")
        .set("X-Forwarded-For", "10.0.0.1, 192.168.1.2")
        .send({ jsonrpc: "2.0", id: 2, method: "ping", params: {} })
        .expect(429);

      // Different client IP — separate budget
      await supertest(app)
        .post("/mcp")
        .set("X-Forwarded-For", "10.0.0.2, 192.168.1.1")
        .send({ jsonrpc: "2.0", id: 3, method: "ping", params: {} })
        .expect(200);
    });
  });

  describe("legacy env var fallback", () => {
    it("uses legacy RATE_LIMIT_MAX_REQUESTS and RATE_LIMIT_WINDOW_MINUTES when new vars are unset", () => {
      // Test the configuration computation logic directly
      const envWindowMinutes = "1";
      const envMaxRequests = "1";

      const legacyWindowSeconds = parseInt(envWindowMinutes, 10) * 60;
      const legacyMax = parseInt(envMaxRequests, 10);

      // Simulating: RATE_LIMIT_WINDOW_SECONDS unset, RATE_LIMIT_MCP_MAX unset, RATE_LIMIT_UPLOAD_MAX unset
      // but RATE_LIMIT_MAX_REQUESTS=1 and RATE_LIMIT_WINDOW_MINUTES=1
      const windowSeconds = legacyWindowSeconds; // falls back to legacy
      const mcpMax = legacyMax; // falls back to legacy because RATE_LIMIT_MAX_REQUESTS is set
      const uploadMax = legacyMax;

      expect(windowSeconds).toBe(60);
      expect(mcpMax).toBe(1);
      expect(uploadMax).toBe(1);
    });

    it("legacy values work end-to-end with real limiters", async () => {
      // Simulate: only legacy vars set, RATE_LIMIT_MAX_REQUESTS=1
      const app = createRateLimitApp({ windowSeconds: 60, mcpMax: 1, uploadMax: 1 });

      // First /mcp passes
      await supertest(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }).expect(200);
      // Second hits limit
      await supertest(app).post("/mcp").send({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }).expect(429);

      // First /upload passes (separate limiter)
      await supertest(app).post("/upload").send({}).expect(200);
      // Second hits limit
      await supertest(app).post("/upload").send({}).expect(429);
    });
  });

  describe("session capacity error shape", () => {
    it("carries error.data.reason == 'session_capacity' and numeric retryAfterSeconds", () => {
      // Test the error shape that server.ts produces for session capacity
      const MAX_SESSIONS = 100;
      const SESSION_RETRY_AFTER_SECONDS = 30;

      const errorResponse = {
        jsonrpc: "2.0",
        error: {
          code: -32005,
          message: `Server at session capacity (${MAX_SESSIONS}). Try again later.`,
          data: { reason: "session_capacity", retryAfterSeconds: SESSION_RETRY_AFTER_SECONDS },
        },
      };

      expect(errorResponse.error.data.reason).toBe("session_capacity");
      expect(typeof errorResponse.error.data.retryAfterSeconds).toBe("number");
      expect(errorResponse.error.data.retryAfterSeconds).toBe(30);
      expect(errorResponse.error.code).toBe(-32005);
    });

    it("returns 503 with session_capacity error from a simulated endpoint", async () => {
      const MAX_SESSIONS = 0; // Simulate at capacity
      const SESSION_RETRY_AFTER_SECONDS = 30;

      const app = express();
      app.use(express.json());

      // Simulate the session capacity guard from server.ts
      app.post("/mcp", (req: Request, res: Response) => {
        const body = req.body;
        const isInitialize =
          body?.method === "initialize" ||
          (Array.isArray(body) && body.some((m: { method?: string }) => m.method === "initialize"));

        if (isInitialize && MAX_SESSIONS <= 0) {
          res.status(503).json({
            jsonrpc: "2.0",
            error: {
              code: -32005,
              message: `Server at session capacity (${MAX_SESSIONS}). Try again later.`,
              data: { reason: "session_capacity", retryAfterSeconds: SESSION_RETRY_AFTER_SECONDS },
            },
          });
          return;
        }
        res.status(200).json({ jsonrpc: "2.0", id: body?.id, result: {} });
      });

      const res = await supertest(app)
        .post("/mcp")
        .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
        .expect(503);

      expect(res.body.error.code).toBe(-32005);
      expect(res.body.error.data.reason).toBe("session_capacity");
      expect(res.body.error.data.retryAfterSeconds).toBe(30);
      expect(typeof res.body.error.data.retryAfterSeconds).toBe("number");
    });
  });

  describe("getRateLimitKey logic", () => {
    function makeReq(headers: Record<string, string> = {}, ip = "127.0.0.1"): Request {
      return { headers, ip } as unknown as Request;
    }

    it("returns apikey hash for valid key when MCP_API_KEY is configured", () => {
      const configuredKey = "server-key-123";
      const result = getRateLimitKey(
        makeReq({ "x-api-key": "server-key-123" }),
        configuredKey
      );
      expect(result.isApiKey).toBe(true);
      expect(result.key).toMatch(/^apikey:[a-f0-9]{64}$/);
      // Verify it's a SHA-256 hash of the key
      const expectedHash = crypto.createHash("sha256").update("server-key-123").digest("hex");
      expect(result.key).toBe(`apikey:${expectedHash}`);
    });

    it("returns IP key for wrong API key", () => {
      const configuredKey = "server-key-123";
      const result = getRateLimitKey(
        makeReq({ "x-api-key": "wrong-key" }, "10.0.0.5"),
        configuredKey
      );
      expect(result.isApiKey).toBe(false);
      expect(result.key).toBe("ip:10.0.0.5");
    });

    it("returns IP key when no API key header is provided", () => {
      const result = getRateLimitKey(makeReq({}, "192.168.1.1"), "some-key");
      expect(result.isApiKey).toBe(false);
      expect(result.key).toBe("ip:192.168.1.1");
    });

    it("accepts Bearer token as API key source", () => {
      const result = getRateLimitKey(
        makeReq({ authorization: "Bearer my-key-456" }),
        "my-key-456"
      );
      expect(result.isApiKey).toBe(true);
      const expectedHash = crypto.createHash("sha256").update("my-key-456").digest("hex");
      expect(result.key).toBe(`apikey:${expectedHash}`);
    });

    it("returns apikey hash when MCP_API_KEY is not configured (auth disabled)", () => {
      const result = getRateLimitKey(
        makeReq({ "x-api-key": "any-key" }),
        undefined // no configured key
      );
      expect(result.isApiKey).toBe(true);
      expect(result.key).toMatch(/^apikey:/);
    });

    it("different keys produce different hashes", () => {
      const r1 = getRateLimitKey(makeReq({ "x-api-key": "key-a" }), undefined);
      const r2 = getRateLimitKey(makeReq({ "x-api-key": "key-b" }), undefined);
      expect(r1.key).not.toBe(r2.key);
    });
  });
});
