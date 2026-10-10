/**
 * Session attribute extraction for OTel server spans.
 *
 * Pure CommonJS module -- testable without starting the OTel SDK.
 * Extracts the `mcp-session-id` header from incoming HTTP requests
 * and returns it as a span attribute for trace correlation.
 *
 * @module session-attributes
 */

'use strict';

/** The HTTP header carrying the MCP session identifier. */
const SESSION_ID_HEADER = 'mcp-session-id';

/** The span attribute name for the session ID. */
const ATTR_SESSION_ID = 'session.id';

/** Maximum allowed length for a session ID value. */
const MAX_SESSION_ID_LENGTH = 200;

/**
 * Extract the session ID from an incoming HTTP request object and
 * return it as a span attribute map.
 *
 * Rules:
 *  - If the header is absent, returns an empty object (never invents a value).
 *  - If the header is an array (repeated headers), takes the first element.
 *  - If the value is not a string, returns an empty object.
 *  - The value is trimmed of leading/trailing whitespace.
 *  - If the trimmed value is empty, returns an empty object.
 *  - If the trimmed value exceeds MAX_SESSION_ID_LENGTH, returns an empty
 *    object (rejects rather than truncates).
 *
 * @param {object} request - An object with a `headers` property (Node.js IncomingMessage shape).
 * @returns {Record<string, string>} Attribute map, either `{ 'session.id': value }` or `{}`.
 */
function sessionAttributes(request) {
  if (!request || typeof request !== 'object') {
    return {};
  }

  const headers = request.headers;
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  let raw = headers[SESSION_ID_HEADER];

  // Node.js gives an array for repeated headers -- take the first value.
  if (Array.isArray(raw)) {
    raw = raw[0];
  }

  // Must be a non-empty string after this point.
  if (typeof raw !== 'string') {
    return {};
  }

  const value = raw.trim();

  // Empty after trimming -- treat as absent.
  if (value.length === 0) {
    return {};
  }

  // Reject (not truncate) values exceeding the length cap.
  if (value.length > MAX_SESSION_ID_LENGTH) {
    return {};
  }

  return { [ATTR_SESSION_ID]: value };
}

module.exports = {
  sessionAttributes,
  SESSION_ID_HEADER,
  ATTR_SESSION_ID,
  MAX_SESSION_ID_LENGTH,
};
