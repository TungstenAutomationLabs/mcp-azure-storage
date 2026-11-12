/**
 * API key authentication middleware.
 *
 * Validates every request to /mcp against the `MCP_API_KEY` environment variable.
 * Accepts the key from two sources (checked in order):
 *  1. `X-API-Key` header (standard custom header)
 *  2. `Authorization: Bearer <key>` header (common alternative)
 *
 * Security properties:
 *  - **Fail-closed** -- if MCP_API_KEY is not configured, ALL requests are rejected (HTTP 503).
 *  - **Constant-time comparison** -- compares SHA-256 digests with `crypto.timingSafeEqual` (utils/credentials.ts).
 *  - **No query-param auth** — keys are only accepted via headers, not URLs (which leak to logs).
 *
 * @module middleware/api-key
 */

import { Request, Response, NextFunction } from "express";
import { credentialMatches, presentedCredential } from "../utils/credentials.js";
import { debug, warn, error } from "../utils/otel-logger.js";

/**
 * Express middleware that validates the API key on every request.
 * Mount this on the /mcp route before any MCP handlers.
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.MCP_API_KEY;

  // Fail closed: if no API key is configured at all, reject every request.
  // This prevents accidental unauthenticated access if the env var is missing.
  if (!apiKey) {
    error("MCP_API_KEY not set -- all requests blocked", { component: "auth" });
    res.status(503).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Server misconfigured -- authentication not available.",
      },
    });
    return;
  }

  // Extract the client-provided key from headers (two supported formats).
  // Query-param auth is intentionally NOT supported -- URLs appear in logs.
  const providedKey = presentedCredential(req.headers);

  // Names of the credential headers present, never their values. The
  // attribute name is neutral so the logger's credential redaction keeps it.
  const authHeaders = [
    req.headers["x-api-key"] ? "x-api-key" : "",
    req.headers.authorization ? "authorization" : "",
  ].filter(Boolean).join(",") || "none";
  debug(`${req.method} ${req.path}`, {
    component: "auth",
    authHeaders,
  });

  if (!providedKey) {
    warn("Rejected -- no API key found in request", { component: "auth" });
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
  if (!credentialMatches(apiKey, providedKey)) {
    warn("Rejected -- invalid API key", { component: "auth" });
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

