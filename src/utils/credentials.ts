/**
 * The client credential presented on a request, and comparing it with the
 * configured one. Shared by the API key middleware and the rate limiter so
 * both read the credential the same way.
 *
 * @module utils/credentials
 */

import crypto from "crypto";
import type { IncomingHttpHeaders } from "http";

/**
 * The credential a request presents: the `X-API-Key` header, else the token
 * of an `Authorization: Bearer <token>` header. Query parameters are never
 * read (URLs reach logs).
 */
export function presentedCredential(headers: IncomingHttpHeaders): string | undefined {
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.length > 0) return apiKey;
  const auth = headers.authorization;
  if (typeof auth !== "string") return undefined;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : undefined;
}

/**
 * Constant-time comparison of a presented credential with the configured one.
 *
 * Both are reduced to SHA-256 digests first, so the buffers compared are
 * always 32 bytes: this hides the configured length and never throws (the
 * earlier string-length check let a same-length value with multi-byte
 * characters reach `crypto.timingSafeEqual` with unequal buffers, which
 * throws a RangeError).
 */
export function credentialMatches(configured: string, presented: string): boolean {
  const a = crypto.createHash("sha256").update(configured, "utf8").digest();
  const b = crypto.createHash("sha256").update(presented, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}
