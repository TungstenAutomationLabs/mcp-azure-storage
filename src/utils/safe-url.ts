/**
 * Describe a configured endpoint URL without anything secret in it.
 *
 * Service URLs come from the environment (AZURE_*_SERVICE_URL) and could
 * carry a SAS token in the query, credentials in the user-info part, or a
 * fragment. Where such a URL is shown (a log line, the store-info tool) only
 * scheme, host, port and path are kept.
 *
 * @module utils/safe-url
 */

/** Scheme, host, port and path of `url` (no trailing slash), or `[invalid URL]`. */
export function describeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return "[invalid URL]";
  }
}
