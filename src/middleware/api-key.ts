import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.MCP_API_KEY;

  // Fail closed: if no API key is configured, reject all requests
  if (!apiKey) {
    console.error("[auth] FATAL — MCP_API_KEY not set. All requests blocked.");
    res.status(503).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Server misconfigured — authentication not available.",
      },
    });
    return;
  }

  // Accept API key from:
  // 1. X-API-Key header (standard)
  // 2. Authorization: Bearer <key> header (common alternative)
  const providedKey =
    (req.headers["x-api-key"] as string | undefined) ||
    extractBearerToken(req.headers.authorization);

  console.log(
    `[auth] ${req.method} ${req.path} — ` +
      `x-api-key: ${req.headers["x-api-key"] ? "present" : "missing"}, ` +
      `authorization: ${req.headers.authorization ? "present" : "missing"}`
  );

  if (!providedKey) {
    console.warn(`[auth] REJECTED — no API key found in request`);
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Missing API key. Provide via X-API-Key header or Authorization: Bearer header.",
      },
    });
    return;
  }

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(apiKey, providedKey)) {
    console.warn(`[auth] REJECTED — invalid API key`);
    res.status(403).json({
      jsonrpc: "2.0",
      error: {
        code: -32002,
        message: "Invalid API key",
      },
    });
    return;
  }

  next();
}

function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Compare against self to maintain constant time, then return false
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
