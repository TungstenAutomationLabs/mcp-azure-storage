/**
 * PII scrubber for OpenTelemetry span attributes and log messages.
 *
 * Prevents personally identifiable information (PII) from leaking into
 * telemetry data. Blob names, file paths, entity keys, and query strings
 * often contain personal information (e.g. `john-doe-passport.pdf`,
 * `patient-records/smith.csv`).
 *
 * Scrubbing strategy (v1.4.0+):
 *  - Blob names, file paths, entity keys, and queries are **removed**
 *    entirely (replaced with a fixed placeholder or omitted).
 *  - Container / queue / table / share names are kept in plain text by
 *    default (they are operator-chosen, not user-supplied PII).
 *  - When `OTEL_SCRUB_HMAC_KEY` is set, resource names (container, queue,
 *    table, share) are HMAC'd with that key for correlation without
 *    revealing the name to the telemetry backend.
 *
 * Activation: controlled by `OTEL_SCRUB_PII` environment variable.
 *  - `true` (default) -- scrubbing enabled
 *  - `false` -- scrubbing disabled, attributes set verbatim
 *
 * HMAC correlation: controlled by `OTEL_SCRUB_HMAC_KEY` environment variable.
 *  - When set, resource names are HMAC'd with this key.
 *  - When unset, resource names are kept in plain text.
 *
 * @module utils/pii-scrubber
 */

import crypto from "crypto";

// -- Configuration ------------------------------------------------------------

/** Placeholder used when a PII segment is removed. */
export const REDACTED_PLACEHOLDER = "[redacted]";

/** Check whether PII scrubbing is enabled. Defaults to true. */
export function isPiiScrubEnabled(): boolean {
  const raw = (process.env.OTEL_SCRUB_PII ?? "true").toLowerCase().trim();
  return raw !== "false" && raw !== "0";
}

/**
 * Return the HMAC key for resource name correlation, or null if not set.
 * When set, container/queue/table/share names are HMAC'd instead of
 * being passed in plain text.
 */
export function getHmacKey(): string | null {
  const key = process.env.OTEL_SCRUB_HMAC_KEY;
  return key && key.length > 0 ? key : null;
}

// -- HMAC ---------------------------------------------------------------------

/** HMAC output length in hex characters. */
const HMAC_PREFIX_LENGTH = 16;

/**
 * Produce a short, deterministic HMAC of the input string using the
 * provided key. Used for correlation values that need to link spans
 * to specific resources without revealing the resource name.
 *
 * @param value - The raw string to HMAC.
 * @param key - The HMAC secret key.
 * @returns A 16-character hex HMAC digest.
 */
export function hmacValue(value: string, key: string): string {
  return crypto
    .createHmac("sha256", key)
    .update(value)
    .digest("hex")
    .slice(0, HMAC_PREFIX_LENGTH);
}

// -- Legacy: hashSegment (deprecated) -----------------------------------------

/**
 * @deprecated Since v1.4.0 -- replaced by removal. Returns `[redacted]`
 * regardless of input. Kept for API compatibility with existing callers
 * that have not yet migrated.
 *
 * @param _value - Ignored.
 * @returns The fixed placeholder `[redacted]`.
 */
export function hashSegment(_value: string): string {
  return REDACTED_PLACEHOLDER;
}

// -- Blob name scrubbing ------------------------------------------------------

/**
 * Scrub a blob name (path) for safe inclusion in OTel span attributes.
 *
 * Returns a fixed placeholder regardless of path depth. No structural
 * information (segment count, file extensions) is preserved.
 *
 * @param name - The raw blob name (may include virtual directory path).
 * @returns The fixed placeholder `[redacted]`, or the original if empty.
 */
export function scrubBlobName(name: string): string {
  if (!name) return name;
  return REDACTED_PLACEHOLDER;
}

// -- Resource name scrubbing --------------------------------------------------

/**
 * Scrub a resource name (container, queue, table, or share) for safe
 * inclusion in OTel span attributes.
 *
 * By default, resource names are kept in plain text because they are
 * operator-chosen identifiers, not user-supplied PII. When
 * `OTEL_SCRUB_HMAC_KEY` is set, the name is HMAC'd for correlation.
 *
 * @param name - The raw resource name.
 * @returns The name in plain text or HMAC'd, depending on configuration.
 */
export function scrubContainerName(name: string): string {
  if (!name) return name;
  const hmacKey = getHmacKey();
  if (hmacKey) {
    return hmacValue(name, hmacKey);
  }
  return name;
}

// -- URL scrubbing ------------------------------------------------------------

/**
 * Azure Storage service type, identified from the URL hostname.
 */
type AzureServiceType = "blob" | "queue" | "table" | "file" | null;

/**
 * Identify which Azure Storage service a hostname targets.
 *
 * @param hostname - The URL hostname (e.g. "myaccount.blob.core.windows.net").
 * @returns The service type, or null if not an Azure Storage URL.
 */
function identifyAzureService(hostname: string): AzureServiceType {
  if (hostname.includes(".blob.core.windows.net")) return "blob";
  if (hostname.includes(".queue.core.windows.net")) return "queue";
  if (hostname.includes(".table.core.windows.net")) return "table";
  if (hostname.includes(".file.core.windows.net")) return "file";
  return null;
}

/**
 * Check whether a URL targets an Azurite emulator.
 * Azurite uses localhost/127.0.0.1/[::1] with a port and prefixes
 * paths with `devstoreaccount1` (or other account names).
 *
 * @param hostname - The URL hostname.
 * @returns True if the URL appears to target Azurite.
 */
function isAzuriteHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "[::1]" ||
    h.startsWith("127.")
  );
}

/**
 * Strip entity key parentheses from a table name.
 * Table URLs may include entity keys like `TableName(PartitionKey='...',RowKey='...')`.
 *
 * @param segment - A path segment that may contain entity keys.
 * @returns The segment with parenthesised content removed.
 */
function stripEntityKeys(segment: string): string {
  const parenIdx = segment.indexOf("(");
  if (parenIdx > 0) {
    return segment.slice(0, parenIdx);
  }
  return segment;
}

/**
 * Scrub an Azure Storage URL to remove PII.
 *
 * Keeps only scheme + authority + first path segment (the resource name:
 * container, queue, table, or share). Everything after -- blob paths, file
 * paths, entity keys, message IDs, query strings -- is removed entirely.
 *
 * Supports all four Azure Storage services (blob, queue, table, file)
 * and Azurite emulator URLs (localhost with account-name prefix).
 *
 * When `OTEL_SCRUB_HMAC_KEY` is set, the resource name is HMAC'd.
 *
 * Non-Azure-Storage URLs are returned unchanged.
 *
 * @example
 *   scrubUrl("https://acct.blob.core.windows.net/mycontainer/path/to/secret.pdf?sv=...")
 *   // => "https://acct.blob.core.windows.net/mycontainer"
 *
 *   scrubUrl("https://acct.table.core.windows.net/MyTable(PartitionKey='x',RowKey='y')")
 *   // => "https://acct.table.core.windows.net/MyTable"
 *
 * @param url - The raw URL string.
 * @returns The URL with PII removed, or the original if not Azure Storage.
 */
export function scrubUrl(url: string): string {
  if (!url) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a valid URL -- return as-is
    return url;
  }

  const hostname = parsed.hostname;

  // Identify service type from hostname
  const serviceType = identifyAzureService(hostname);
  const isAzurite = isAzuriteHost(hostname);

  if (!serviceType && !isAzurite) {
    // Not an Azure Storage URL -- return unchanged
    return url;
  }

  // Split path into segments (filter empty from leading/trailing slashes)
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);

  // For Azurite URLs, the first segment is the account name (e.g. "devstoreaccount1"),
  // and the second segment is the resource name. For production Azure URLs, the
  // first segment is the resource name directly.
  let resourceName: string;
  let prefix: string;

  if (isAzurite) {
    // Azurite: scheme://host:port/accountName/resourceName/...
    if (segments.length < 2) {
      // Only account name, no resource -- return origin + account
      return `${parsed.protocol}//${parsed.host}/${segments[0] || ""}`;
    }
    const accountName = segments[0];
    resourceName = stripEntityKeys(segments[1]);
    prefix = `${parsed.protocol}//${parsed.host}/${accountName}`;
  } else {
    // Production Azure: scheme://account.service.core.windows.net/resourceName/...
    if (segments.length < 1) {
      // No resource name -- return origin only
      return `${parsed.protocol}//${parsed.host}`;
    }
    resourceName = stripEntityKeys(segments[0]);
    prefix = `${parsed.protocol}//${parsed.host}`;
  }

  // Optionally HMAC the resource name
  const hmacKey = getHmacKey();
  const scrubbedResourceName = hmacKey
    ? hmacValue(resourceName, hmacKey)
    : resourceName;

  // Return scheme + host + resource name only (no further path, no query)
  return `${prefix}/${scrubbedResourceName}`;
}

// -- Path scrubbing -----------------------------------------------------------

/**
 * Scrub a URL path for the `url.path` / `http.target` span attribute.
 *
 * Returns only the first path segment (resource name) for Azure Storage
 * URLs, or the full path for non-Azure URLs.
 *
 * @param path - The raw URL path (e.g. "/container/blob/path").
 * @param hostname - The hostname to identify the service type.
 * @returns The scrubbed path.
 */
export function scrubUrlPath(path: string, hostname: string): string {
  if (!path) return path;

  const serviceType = identifyAzureService(hostname);
  const isAzurite = isAzuriteHost(hostname);

  if (!serviceType && !isAzurite) {
    return path;
  }

  const segments = path.split("/").filter((s) => s.length > 0);

  if (isAzurite) {
    if (segments.length < 2) return path;
    const accountName = segments[0];
    const resourceName = stripEntityKeys(segments[1]);
    const hmacKey = getHmacKey();
    const scrubbedName = hmacKey ? hmacValue(resourceName, hmacKey) : resourceName;
    return `/${accountName}/${scrubbedName}`;
  }

  if (segments.length < 1) return path;
  const resourceName = stripEntityKeys(segments[0]);
  const hmacKey = getHmacKey();
  const scrubbedName = hmacKey ? hmacValue(resourceName, hmacKey) : resourceName;
  return `/${scrubbedName}`;
}

// -- Convenience: conditional scrubbing ---------------------------------------

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
 * Conditionally scrub a container/resource name based on the OTEL_SCRUB_PII setting.
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
