/**
 * PII scrubber for OpenTelemetry span attributes and log messages.
 *
 * Prevents personally identifiable information (PII) from leaking into
 * telemetry data. Blob names and container names often contain personal
 * information (e.g. `john-doe-passport.pdf`, `patient-records/smith.csv`).
 *
 * Scrubbing strategy:
 *  - Each path segment and the filename stem are replaced with a truncated
 *    SHA-256 hash (first 8 hex characters).
 *  - File extensions are preserved (they carry no PII but aid debugging).
 *  - Virtual directory structure is preserved (segment count / depth).
 *  - Container names are hashed per-segment (split on `-`).
 *
 * Activation: controlled by `OTEL_SCRUB_PII` environment variable.
 *  - `true` (default in production) -- scrubbing enabled
 *  - `false` -- scrubbing disabled, attributes set verbatim
 *
 * @module utils/pii-scrubber
 */

import crypto from "crypto";

// ── Configuration ────────────────────────────────────────────────────────────

/** Check whether PII scrubbing is enabled. Defaults to true. */
export function isPiiScrubEnabled(): boolean {
  const raw = (process.env.OTEL_SCRUB_PII ?? "true").toLowerCase().trim();
  return raw !== "false" && raw !== "0";
}

// ── Core hashing ─────────────────────────────────────────────────────────────

/** Hash length in hex characters (8 hex = 4 bytes = ~4 billion values). */
const HASH_PREFIX_LENGTH = 8;

/**
 * Produce a short, deterministic, irreversible hash of the input string.
 *
 * Uses SHA-256 truncated to 8 hex characters. The same input always
 * produces the same output, which aids debugging while preventing PII
 * from being recoverable.
 *
 * @param value - The raw string to hash.
 * @returns An 8-character hex digest.
 */
export function hashSegment(value: string): string {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, HASH_PREFIX_LENGTH);
}

// ── Blob name scrubbing ──────────────────────────────────────────────────────

/**
 * Scrub a blob name (path) for safe inclusion in OTel span attributes.
 *
 * Preserves virtual directory structure and file extension while hashing
 * each path segment and the filename stem.
 *
 * @example
 *   scrubBlobName("clients/john-doe/passport-scan.pdf")
 *   // => "a1b2c3d4/e5f6a7b8/9c0d1e2f.pdf"
 *
 *   scrubBlobName("report.csv")
 *   // => "3f4a5b6c.csv"
 *
 *   scrubBlobName("data/archive/")
 *   // => "7d8e9f0a/1b2c3d4e/"
 *
 * @param name - The raw blob name (may include virtual directory path).
 * @returns The scrubbed blob name with hashed segments.
 */
export function scrubBlobName(name: string): string {
  if (!name) return name;

  // Preserve trailing slash (directory marker)
  const trailingSlash = name.endsWith("/");

  const segments = name.split("/").filter((s) => s.length > 0);
  const scrubbed = segments.map((segment) => {
    // Split filename from extension for the last segment
    const dotIndex = segment.lastIndexOf(".");
    if (dotIndex > 0 && dotIndex < segment.length - 1) {
      const stem = segment.slice(0, dotIndex);
      const ext = segment.slice(dotIndex); // includes the dot
      return hashSegment(stem) + ext;
    }
    return hashSegment(segment);
  });

  return scrubbed.join("/") + (trailingSlash ? "/" : "");
}

// ── Container name scrubbing ─────────────────────────────────────────────────

/**
 * Scrub a container name for safe inclusion in OTel span attributes.
 *
 * Container names are restricted to `[a-z0-9-]` so PII risk is lower,
 * but they could still contain identifiers (e.g. `client-12345`).
 * The entire name is hashed as a single unit.
 *
 * @param name - The raw container name.
 * @returns The hashed container name.
 */
export function scrubContainerName(name: string): string {
  if (!name) return name;
  return hashSegment(name);
}

// ── URL scrubbing ────────────────────────────────────────────────────────────

/**
 * Scrub an Azure Storage URL to remove PII from the blob path.
 *
 * Detects URLs targeting `*.blob.core.windows.net` and replaces the
 * blob path (everything after the container name) with hashed segments.
 * The host, container name, and query parameters (SAS tokens) are
 * preserved, though the container name is also scrubbed.
 *
 * Non-Azure-Storage URLs are returned unchanged.
 *
 * @example
 *   scrubUrl("https://myaccount.blob.core.windows.net/docs/john-doe/passport.pdf?sv=2024...")
 *   // => "https://myaccount.blob.core.windows.net/a1b2c3d4/e5f6a7b8/9c0d1e2f.pdf?sv=2024..."
 *
 * @param url - The raw URL string.
 * @returns The URL with scrubbed blob path, or the original URL if not
 *          an Azure Storage URL.
 */
export function scrubUrl(url: string): string {
  if (!url) return url;

  // Match Azure Blob Storage URLs:
  //   https://<account>.blob.core.windows.net/<container>/<blobPath>?<query>
  // Also match Azurite-style URLs:
  //   http://127.0.0.1:10000/<account>/<container>/<blobPath>
  const azureBlobPattern =
    /^(https?:\/\/[^/]+\.blob\.core\.windows\.net\/)([^/?]+)(\/[^?]*)(\?.*)?$/;
  const azuritePattern =
    /^(https?:\/\/(?:localhost|127\.0\.0\.1|(?:\[::1\])):\d+\/[^/]+\/)([^/?]+)(\/[^?]*)(\?.*)?$/;

  for (const pattern of [azureBlobPattern, azuritePattern]) {
    const match = url.match(pattern);
    if (match) {
      const [, prefix, container, blobPath, query] = match;
      const scrubbedContainer = scrubContainerName(container);
      // blobPath starts with "/" -- remove it, scrub, then re-add
      const rawPath = blobPath.slice(1);
      const scrubbedPath = rawPath ? "/" + scrubBlobName(rawPath) : "";
      return prefix + scrubbedContainer + scrubbedPath + (query || "");
    }
  }

  return url;
}

// ── Convenience: conditional scrubbing ───────────────────────────────────────

/**
 * Conditionally scrub a blob name based on the OTEL_SCRUB_PII setting.
 *
 * @param name - The raw blob name.
 * @returns The scrubbed name (if enabled) or the original name.
 */
export function maybeScrubBlobName(name: string): string {
  return isPiiScrubEnabled() ? scrubBlobName(name) : name;
}

/**
 * Conditionally scrub a container name based on the OTEL_SCRUB_PII setting.
 *
 * @param name - The raw container name.
 * @returns The scrubbed name (if enabled) or the original name.
 */
export function maybeScrubContainerName(name: string): string {
  return isPiiScrubEnabled() ? scrubContainerName(name) : name;
}

/**
 * Conditionally scrub a URL based on the OTEL_SCRUB_PII setting.
 *
 * @param url - The raw URL string.
 * @returns The scrubbed URL (if enabled) or the original URL.
 */
export function maybeScrubUrl(url: string): string {
  return isPiiScrubEnabled() ? scrubUrl(url) : url;
}
