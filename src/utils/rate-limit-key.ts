/**
 * Rate-limit identity for /mcp and /upload.
 *
 * The limiters run BEFORE authentication, so every request is counted,
 * including ones that present no credential or a wrong one:
 *
 *  - a request presenting the configured MCP_API_KEY is counted in the
 *    authenticated clients' bucket. The server accepts one key, so all
 *    holders of it share this budget (as before, when the bucket was named
 *    after a digest of that one key). The bucket name holds no material
 *    derived from the credential;
 *  - every other request (no credential, a wrong or malformed one, or any
 *    credential while MCP_API_KEY is unset) is counted against its client
 *    address. A caller cannot open new budgets by changing the key it
 *    sends, so guessing keys is throttled per address. The address is
 *    `req.ip`, which honours the "trust proxy" setting: X-Forwarded-For is
 *    believed only for the configured number of proxy hops. IPv6 addresses
 *    are grouped by /56 subnet;
 *  - a request whose address cannot be resolved shares one "unknown"
 *    bucket, so a missing address never escapes the limit.
 *
 * @module utils/rate-limit-key
 */

import type { Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import { credentialMatches, presentedCredential } from "./credentials.js";

/** Bucket shared by requests that present the configured credential. */
export const AUTHENTICATED_CLIENT_BUCKET = "client:authenticated";

/** Rate-limit identity of a request. */
export interface RateLimitIdentity {
  /** The limiter's bucket name. */
  key: string;
  /** True when the request presented the configured credential. */
  isApiKey: boolean;
}

/**
 * Derive the rate-limit identity of a request.
 *
 * @param req - The Express request (`req.ip` must already reflect trust proxy).
 * @param configuredKey - The server's MCP_API_KEY (read per call, so tests and
 *   a rotated key take effect without a restart).
 */
export function getRateLimitKey(
  req: Pick<Request, "headers" | "ip">,
  configuredKey: string | undefined = process.env.MCP_API_KEY,
): RateLimitIdentity {
  const presented = presentedCredential(req.headers);
  if (configuredKey && presented !== undefined && credentialMatches(configuredKey, presented)) {
    return { key: AUTHENTICATED_CLIENT_BUCKET, isApiKey: true };
  }
  // IPv6 addresses are grouped by /56 subnet (express-rate-limit's default),
  // so a caller cannot open new budgets by rotating within its allocation.
  return { key: `ip:${req.ip ? ipKeyGenerator(req.ip) : "unknown"}`, isApiKey: false };
}
