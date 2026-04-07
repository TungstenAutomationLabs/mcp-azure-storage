/**
 * API key authentication middleware.
 *
 * Validates every request to /mcp against the `MCP_API_KEY` environment variable.
 * Accepts the key from two sources (checked in order):
 *  1. `X-API-Key` header (standard custom header)
 *  2. `Authorization: Bearer <key>` header (common alternative)
 *
 * Security properties:
 *  - **Fail-closed** — if MCP_API_KEY is not configured, ALL requests are rejected (HTTP 503).
 *  - **Constant-time comparison** — uses `crypto.timingSafeEqual` to prevent timing attacks.
 *  - **No query-param auth** — keys are only accepted via headers, not URLs (which leak to logs).
 *
 * @module middleware/api-key
 */

import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

/**
 * Express middleware that validates the API key on every request.
 * Mount this on the /mcp route before any MCP handlers.
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.MCP_API_KEY;

  // Fail closed: if no API key is configured at all, reject every request.
  // This prevents accidental unauthenticated access if the env var is missing.
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

  // Extract the client-provided key from headers (two supported formats).
  // Query-param auth is intentionally NOT supported — URLs appear in logs.
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

  // Constant-time comparison prevents an attacker from measuring response
  // times to determine how many characters of the key are correct.
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

/**
 * Extract the token from an `Authorization: Bearer <token>` header.
 *
 * @param authHeader - The raw Authorization header value.
 * @returns The token string, or undefined if the header is missing/malformed.
 */
function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : undefined;
}

/**
 * Constant-time string comparison using `crypto.timingSafeEqual`.
 *
 * When lengths differ, we still perform a comparison (against self) to avoid
 * leaking length information via timing. The function always returns false
 * for mismatched lengths.
 *
 * @param a - Expected value (server-side API key).
 * @param b - Provided value (client-submitted key).
 * @returns true if the strings are identical.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Compare `a` against itself to burn the same CPU time, then return false
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
