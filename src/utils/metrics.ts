/**
 * OTel metrics utility module.
 *
 * Provides thin wrappers around OpenTelemetry counters for operational
 * visibility.  All functions are safe to call when OTel is not configured
 * -- they degrade to no-ops without throwing.
 *
 * Metric names follow the `mcp.*` namespace convention.  Labels use a
 * bounded set of values (tool names from the fixed registration list,
 * JSON-RPC method strings) to prevent high-cardinality explosions.
 *
 * @module utils/metrics
 */

import { metrics, type Counter, type Meter } from "@opentelemetry/api";

// -- Known tools (bounded label set) -----------------------------------------
// Imported from the canonical list in server.ts at build time.  Kept as a
// plain Set here so the module has zero runtime coupling to the server.

/** Canonical set of all registered MCP tool names. */
export const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  // blob-tools.ts (14 tools)
  "blob-container-create",
  "blob-container-delete",
  "blob-container-exists",
  "blob-list",
  "blob-create",
  "blob-head",
  "blob-read",
  "blob-delete",
  "blob-delete-batch",
  "blob-set-metadata",
  "blob-set-tier",
  "blob-get-sas-url",
  "blob-get-container-sas",
  "blob-upload-from-url",
  // fileshare-tools.ts (8 tools)
  "fileshare-list-shares",
  "fileshare-create-share",
  "fileshare-delete-share",
  "fileshare-create-directory",
  "fileshare-delete-directory",
  "fileshare-upload-file",
  "fileshare-read-file",
  "fileshare-delete-file",
  // queue-tools.ts (8 tools)
  "queue-create",
  "queue-delete",
  "queue-send-message",
  "queue-peek-messages",
  "queue-receive-messages",
  "queue-delete-message",
  "queue-update-message",
  "queue-renew-lease",
  // table-tools.ts (5 tools)
  "table-create",
  "table-delete",
  "table-entity-upsert",
  "table-entity-query",
  "table-entity-delete",
  // utility-tools.ts (8 tools)
  "util-to-base64",
  "util-from-base64",
  "util-refresh-blob-sas",
  "util-refresh-container-sas",
  "util-get-content-type",
  "util-to-container-name",
  "util-get-upload-url",
  "store-info",
]);

// -- Lazy-initialised counters ------------------------------------------------
// Counters are created on first use so the OTel SDK has time to start via
// --require.  If no meter provider is registered the API returns a no-op
// meter, which is harmless.

let _meter: Meter | null = null;
let _requestsCounter: Counter | null = null;
let _errorsCounter: Counter | null = null;
let _startsCounter: Counter | null = null;
let _staleSessionsCounter: Counter | null = null;

/** Return (or lazily create) the OTel meter for this module. */
function getMeter(): Meter {
  if (!_meter) {
    _meter = metrics.getMeter("mcp-azure-storage");
  }
  return _meter;
}

/** Return (or lazily create) the `mcp.requests.total` counter. */
function getRequestsCounter(): Counter {
  if (!_requestsCounter) {
    _requestsCounter = getMeter().createCounter("mcp.requests.total", {
      description: "Total MCP JSON-RPC requests received",
    });
  }
  return _requestsCounter;
}

/** Return (or lazily create) the `mcp.requests.errors` counter. */
function getErrorsCounter(): Counter {
  if (!_errorsCounter) {
    _errorsCounter = getMeter().createCounter("mcp.requests.errors", {
      description: "Total MCP JSON-RPC request errors",
    });
  }
  return _errorsCounter;
}

/** Return (or lazily create) the `mcp.server.starts` counter. */
function getStartsCounter(): Counter {
  if (!_startsCounter) {
    _startsCounter = getMeter().createCounter("mcp.server.starts", {
      description: "Number of times the MCP server process has started",
    });
  }
  return _startsCounter;
}

/** Return (or lazily create) the `mcp.stale_sessions.received` counter. */
function getStaleSessionsCounter(): Counter {
  if (!_staleSessionsCounter) {
    _staleSessionsCounter = getMeter().createCounter(
      "mcp.stale_sessions.received",
      {
        description:
          "Requests received with an Mcp-Session-Id header (ignored in stateless mode)",
      },
    );
  }
  return _staleSessionsCounter;
}

// -- Public API ---------------------------------------------------------------

/**
 * Sanitise a tool name against the known set.
 *
 * Returns the tool name verbatim if it is in {@link KNOWN_TOOLS},
 * otherwise returns `"unknown"`.  This prevents arbitrary user-supplied
 * strings from becoming metric label values.
 */
export function sanitiseToolName(toolName: string | undefined): string {
  if (!toolName) return "unknown";
  return KNOWN_TOOLS.has(toolName) ? toolName : "unknown";
}

/**
 * Record an incoming MCP request.
 *
 * @param method  - The JSON-RPC method (e.g. `"tools/call"`, `"initialize"`).
 * @param toolName - For `tools/call` requests, the tool name from `params.name`.
 *                   Sanitised to the known set before recording.
 */
export function recordRequest(
  method: string,
  toolName?: string,
): void {
  try {
    const attrs: Record<string, string> = { method };
    if (toolName !== undefined) {
      attrs.tool = sanitiseToolName(toolName);
    }
    getRequestsCounter().add(1, attrs);
  } catch {
    // Never break the request path for metrics failures.
  }
}

/**
 * Record an MCP request error.
 *
 * @param method - The JSON-RPC method that errored.
 */
export function recordError(method: string): void {
  try {
    getErrorsCounter().add(1, { method });
  } catch {
    // Swallow -- never break the request path.
  }
}

/**
 * Record that a stale Mcp-Session-Id header was received.
 */
export function recordStaleSession(): void {
  try {
    getStaleSessionsCounter().add(1);
  } catch {
    // Swallow.
  }
}

/**
 * Record a server start event.  Call once at startup.
 */
export function recordServerStart(): void {
  try {
    getStartsCounter().add(1);
  } catch {
    // Swallow.
  }
}

/**
 * Reset internal counter references.
 *
 * Test-only: allows tests to inject a fresh meter provider and
 * have the counters re-created on next use.
 */
export function _resetForTesting(): void {
  _meter = null;
  _requestsCounter = null;
  _errorsCounter = null;
  _startsCounter = null;
  _staleSessionsCounter = null;
}
