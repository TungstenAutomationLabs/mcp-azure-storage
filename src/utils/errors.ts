/**
 * Structured error mapping for MCP tool responses.
 *
 * Every tool handler is wrapped by the error interceptor applied via
 * {@link wrapToolErrorHandler}. When a handler throws, the error is
 * converted to a {@link StructuredError} and re-thrown as
 * `new Error(JSON.stringify({ error: <payload> }))` so the MCP SDK
 * surfaces it as `isError: true` with a single text content item
 * containing the JSON string.
 *
 * Consumers parse the text to get a machine-readable error with a fixed
 * `code` discriminator, HTTP status, retryability flag, and optional
 * context-specific fields.
 *
 * @module utils/errors
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { trace } from "@opentelemetry/api";

// ── Structured error shape ───────────────────────────────────────────────────

/**
 * Fixed set of error codes returned by all tools.
 *
 * Each code maps to a specific category of failure with well-defined
 * semantics for retry, resolution, and extra fields.
 */
export type ErrorCode =
  | "not_found"
  | "already_exists"
  | "lease_lost"
  | "immutable"
  | "archived"
  | "too_large"
  | "rate_limited"
  | "invalid"
  | "forbidden"
  | "backend";

/**
 * The structured error payload embedded in every `isError: true` response.
 */
export interface StructuredError {
  /** Fixed discriminator from the {@link ErrorCode} union. */
  code: ErrorCode;
  /** HTTP status code from the Azure REST response, or `null` for non-HTTP errors. */
  status: number | null;
  /** The Azure-specific error code string (e.g. "BlobNotFound"), when available. */
  azureCode?: string;
  /** Human-readable message. Starts with the Azure code when known. */
  message: string;
  /** Whether the caller should retry the same request. */
  retryable: boolean;
  /** ISO 8601 timestamp when the immutability policy expires (immutable errors only). */
  immutableUntil?: string;
  /** Current rehydration status (archived errors only). */
  archiveStatus?: string;
  /** Maximum allowed size in bytes (too_large errors only). */
  maxBytes?: number;
  /** Seconds to wait before retrying (rate_limited errors only). */
  retryAfterSeconds?: number;
  /** The invalid parameter/field name (invalid errors only). */
  field?: string;
  /** Any additional context not covered by the typed fields. */
  additional?: Record<string, unknown>;
}

// ── SAS / secret sanitisation ────────────────────────────────────────────────

/**
 * Sensitive query parameter names found in Azure SAS tokens.
 * Values are replaced with `<redacted>` in error messages.
 */
const SENSITIVE_PARAMS = ["sig", "se", "sp", "sr", "sk"];

/**
 * Strip SAS signatures and other sensitive query parameters from a message.
 *
 * Matches `param=value` patterns in query strings and replaces the value
 * portion with `<redacted>`. Preserves the rest of the message content.
 *
 * @param message - Raw error message that may contain SAS URLs.
 * @returns Sanitised message with sensitive values removed.
 */
export function sanitizeMessage(message: string): string {
  let result = message;
  for (const param of SENSITIVE_PARAMS) {
    // Match the param name (case-insensitive) followed by = and its value
    // Value ends at & (next param), space, quote, end of string, or closing paren
    const pattern = new RegExp(
      `(${param})=([^&\\s"'\\)]+)`,
      "gi"
    );
    result = result.replace(pattern, `$1=<redacted>`);
  }
  return result;
}

// ── Azure error code → StructuredError mapping ───────────────────────────────

/** Azure error codes that map to "not_found". */
const NOT_FOUND_CODES = new Set([
  "BlobNotFound",
  "ContainerNotFound",
  "QueueNotFound",
  "TableNotFound",
  "ShareNotFound",
  "ResourceNotFound",
  "ParentNotFound",
  "ShareBeingDeleted",
]);

/** Azure error codes that map to "already_exists". */
const ALREADY_EXISTS_CODES = new Set([
  "ContainerAlreadyExists",
  "QueueAlreadyExists",
  "TableAlreadyExists",
  "BlobAlreadyExists",
  "ShareAlreadyExists",
  "ResourceAlreadyExists",
]);

/** Azure error codes that map to "lease_lost". */
const LEASE_LOST_CODES = new Set([
  "MessageNotFound",
  "PopReceiptMismatch",
  "LeaseIdMissing",
  "LeaseIdMismatch",
  "LeaseAlreadyPresent",
]);

/** Azure error codes that map to "immutable". */
const IMMUTABLE_CODES = new Set([
  "BlobImmutableDueToPolicy",
  "BlobImmutableDueToLegalHold",
]);

/** Azure error codes that map to "archived". */
const ARCHIVED_CODES = new Set([
  "BlobArchived",
  "BlobBeingRehydrated",
]);

/**
 * Type guard for Azure SDK RestError instances.
 *
 * We duck-type rather than importing RestError to avoid pulling in the
 * Azure SDK at the utils level. RestError always has `statusCode` and `code`.
 */
function isRestError(err: unknown): err is {
  name: string;
  message: string;
  statusCode?: number;
  code?: string;
  details?: { code?: string; message?: string };
  response?: {
    headers?: { get?(name: string): string | undefined };
    parsedBody?: Record<string, unknown>;
  };
} {
  if (err == null || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  return e.name === "RestError" || (typeof e.statusCode === "number" && typeof e.code === "string");
}

/**
 * Extract the Azure error code from a RestError.
 *
 * Azure SDKs put the specific code in various places depending on the
 * service. This function checks common locations in priority order.
 */
function extractAzureCode(err: {
  code?: string;
  details?: { code?: string };
  response?: { parsedBody?: Record<string, unknown> };
}): string | undefined {
  // Prefer the nested details code (more specific), then top-level code
  const detailCode = err.details?.code;
  if (detailCode) return detailCode;

  // Some Azure errors put the specific code in response.parsedBody
  const bodyCode =
    err.response?.parsedBody?.Code ??
    err.response?.parsedBody?.code;
  if (typeof bodyCode === "string") return bodyCode;

  // Fall back to top-level code (may be generic like "REQUEST_SEND_ERROR")
  return err.code;
}

/**
 * Build the `message` field: "{AzureCode}: {Azure message}" when possible.
 */
function buildMessage(azureCode: string | undefined, rawMessage: string): string {
  const sanitised = sanitizeMessage(rawMessage);
  if (azureCode && !sanitised.startsWith(azureCode)) {
    return `${azureCode}: ${sanitised}`;
  }
  return sanitised;
}

/**
 * Map any thrown error to a {@link StructuredError}.
 *
 * Handles Azure SDK RestError instances with specific code/status mapping,
 * custom application error types (TooLargeError, InvalidArgumentError),
 * and generic exceptions.
 *
 * @param err - The caught exception (any type).
 * @returns A structured error payload ready for JSON serialisation.
 */
export function mapRestError(err: unknown): StructuredError {
  // ── Custom application errors ──────────────────────────────────────────

  // TooLargeError (future Items 3/6 — detect by name or symbol)
  if (err != null && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const TOO_LARGE_SYM = Symbol.for("too_large");
    if (
      e.name === "TooLargeError" ||
      (e as unknown as Record<symbol, unknown>)[TOO_LARGE_SYM] === true
    ) {
      return {
        code: "too_large",
        status: null,
        message: sanitizeMessage(String(e.message || "Payload too large")),
        retryable: false,
        ...(typeof e.maxBytes === "number" ? { maxBytes: e.maxBytes } : {}),
      };
    }

    // InvalidArgumentError (our own validation failures)
    if (
      e.name === "InvalidArgumentError" ||
      e.code === "ERR_INVALID_ARG"
    ) {
      return {
        code: "invalid",
        status: null,
        message: sanitizeMessage(String(e.message || "Invalid argument")),
        retryable: false,
        ...(typeof e.field === "string" ? { field: e.field } : {}),
      };
    }
  }

  // ── Azure RestError ────────────────────────────────────────────────────

  if (isRestError(err)) {
    const statusCode = err.statusCode ?? null;
    const azureCode = extractAzureCode(err);
    const message = buildMessage(azureCode, err.message);

    // not_found: 404 with a known "not found" azure code
    if (statusCode === 404 && azureCode && NOT_FOUND_CODES.has(azureCode)) {
      return {
        code: "not_found",
        status: statusCode,
        azureCode,
        message,
        retryable: false,
      };
    }
    // Also map 404 without a specific code to not_found
    if (statusCode === 404) {
      return {
        code: "not_found",
        status: statusCode,
        ...(azureCode ? { azureCode } : {}),
        message,
        retryable: false,
      };
    }

    // already_exists: 409 with a code ending in AlreadyExists
    if (statusCode === 409 && azureCode && ALREADY_EXISTS_CODES.has(azureCode)) {
      return {
        code: "already_exists",
        status: statusCode,
        azureCode,
        message,
        retryable: false,
      };
    }
    // Also catch any 409 code ending with "AlreadyExists"
    if (statusCode === 409 && azureCode?.endsWith("AlreadyExists")) {
      return {
        code: "already_exists",
        status: statusCode,
        azureCode,
        message,
        retryable: false,
      };
    }

    // lease_lost: specific codes regardless of status
    if (azureCode && LEASE_LOST_CODES.has(azureCode)) {
      return {
        code: "lease_lost",
        status: statusCode,
        azureCode,
        message,
        retryable: false,
      };
    }

    // immutable: immutability policy / legal hold codes
    if (azureCode && IMMUTABLE_CODES.has(azureCode)) {
      const result: StructuredError = {
        code: "immutable",
        status: statusCode,
        azureCode,
        message,
        retryable: false,
      };
      // Best effort: extract immutableUntil from response if available
      const parsedBody = err.response?.parsedBody;
      if (parsedBody && typeof parsedBody.ImmutabilityPolicyExpiresOn === "string") {
        result.immutableUntil = parsedBody.ImmutabilityPolicyExpiresOn;
      }
      return result;
    }

    // archived: blob archived / rehydrating
    if (azureCode && ARCHIVED_CODES.has(azureCode)) {
      const result: StructuredError = {
        code: "archived",
        status: statusCode,
        azureCode,
        message,
        retryable: false,
      };
      // Best effort: extract archive status from response
      const parsedBody = err.response?.parsedBody;
      if (parsedBody && typeof parsedBody.ArchiveStatus === "string") {
        result.archiveStatus = parsedBody.ArchiveStatus;
      }
      return result;
    }

    // rate_limited: 429
    if (statusCode === 429) {
      const result: StructuredError = {
        code: "rate_limited",
        status: statusCode,
        ...(azureCode ? { azureCode } : {}),
        message,
        retryable: true,
      };
      // Extract Retry-After header
      const retryAfter = err.response?.headers?.get?.("retry-after") ??
        err.response?.headers?.get?.("Retry-After");
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds) && seconds > 0) {
          result.retryAfterSeconds = seconds;
        }
      }
      return result;
    }

    // forbidden: 403
    if (statusCode === 403) {
      return {
        code: "forbidden",
        status: statusCode,
        ...(azureCode ? { azureCode } : {}),
        message,
        retryable: false,
      };
    }

    // invalid: 400 with client-error azure code
    if (statusCode === 400) {
      return {
        code: "invalid",
        status: statusCode,
        ...(azureCode ? { azureCode } : {}),
        message,
        retryable: false,
      };
    }

    // backend: everything else
    const is5xx = statusCode !== null && statusCode >= 500 && statusCode < 600;
    return {
      code: "backend",
      status: statusCode,
      ...(azureCode ? { azureCode } : {}),
      message,
      retryable: is5xx,
    };
  }

  // ── Generic / unknown errors ───────────────────────────────────────────

  const rawMessage = err instanceof Error ? err.message : String(err);
  return {
    code: "backend",
    status: null,
    message: sanitizeMessage(rawMessage),
    retryable: false,
  };
}

// ── server.tool() wrapper ────────────────────────────────────────────────────

/**
 * Monkey-patch `server.tool()` so every registered handler is wrapped
 * in a try/catch that converts exceptions to structured error JSON.
 *
 * Must be called **before** any tool registrations (registerBlobTools, etc.).
 *
 * The wrapper preserves full signature parity with all `server.tool()`
 * overloads — it simply intercepts the last argument (always the handler
 * callback) and wraps it.
 *
 * @param server - The McpServer instance to patch.
 */
export function wrapToolErrorHandler(server: McpServer): void {
  const origTool = server.tool.bind(server);

  (server as any).tool = function patchedTool(...args: unknown[]) {
    // The first argument is always the tool name string.
    const toolName = typeof args[0] === "string" ? args[0] : undefined;

    // The last argument is always the handler callback.
    const handler = args[args.length - 1];
    if (typeof handler === "function") {
      const wrappedHandler = async (...handlerArgs: unknown[]) => {
        // Enrich the active OTel span with tool metadata.
        // trace.getActiveSpan() returns undefined when no SDK is loaded,
        // so this is a safe no-op without OTel.
        const span = trace.getActiveSpan();
        if (span && toolName) {
          span.setAttribute("mcp.tool.name", toolName);
          span.setAttribute("peer.service", "azure-storage");
        }

        try {
          const result = await (handler as Function).apply(null, handlerArgs);

          // Blob-specific span enrichment: set container, blob name, and
          // content length (when known) from the handler parameters.
          if (span && toolName?.startsWith("blob-")) {
            const params = handlerArgs[0] as Record<string, unknown> | undefined;
            if (params && typeof params === "object") {
              if (typeof params.containerName === "string") {
                span.setAttribute("blob.container_name", params.containerName);
              }
              if (typeof params.blobName === "string") {
                span.setAttribute("blob.name", params.blobName);
              }
              // Estimate content length from base64 payload (blob-create).
              if (typeof params.contentBase64 === "string") {
                const b64Len = params.contentBase64.length;
                // Base64 encodes 3 bytes into 4 chars; approximate decoded size.
                const approxBytes = Math.floor((b64Len * 3) / 4);
                span.setAttribute("blob.content_length", approxBytes);
              }
            }
          }

          return result;
        } catch (err: unknown) {
          const structured = mapRestError(err);
          throw new Error(JSON.stringify({ error: structured }));
        }
      };
      args[args.length - 1] = wrappedHandler;
    }
    return (origTool as Function).apply(server, args);
  };
}
