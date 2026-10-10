/**
 * Structured logger with optional OpenTelemetry log record emission.
 *
 * Writes to stdout (preserving existing behaviour) and, when the OTel
 * SDK is active, also emits OTel log records with trace correlation.
 *
 * The OTel logger is fetched LAZILY at emit time -- not at module load.
 * The logs API returns a no-op logger if no provider is registered yet,
 * and a cached no-op never upgrades.  By deferring the lookup we ensure
 * the real provider is used once the SDK has started.
 *
 * @module utils/otel-logger
 */

import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { context, trace } from "@opentelemetry/api";

/** Severity levels supported by the OTel logger. */
export type OtelLogSeverity = "DEBUG" | "INFO" | "WARN" | "ERROR";

/** Map from severity name to OTel SeverityNumber. */
const SEVERITY_NUMBER_MAP: Record<OtelLogSeverity, SeverityNumber> = {
  DEBUG: SeverityNumber.DEBUG,
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
};

/** Map from severity name to SeverityNumber for filtering. */
const SEVERITY_RANK: Record<OtelLogSeverity, number> = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

/**
 * Resolve the minimum severity from the environment variable.
 * Returns 0 (allow all) when no filter is configured.
 */
function getMinSeverity(): number {
  const envVal = process.env.OTEL_LOG_MIN_SEVERITY;
  if (!envVal) return 0;
  const upper = envVal.toUpperCase() as OtelLogSeverity;
  return SEVERITY_RANK[upper] ?? 0;
}

/**
 * Emit a structured log record to both stdout and OTel (when active).
 *
 * @param severity - The log severity level.
 * @param message - The log message body.
 * @param attributes - Optional key-value attributes to attach.
 */
function emit(
  severity: OtelLogSeverity,
  message: string,
  attributes?: Record<string, string | number | boolean>,
): void {
  // Always write to stdout (preserves existing behaviour).
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] ${severity}:`;
  if (severity === "ERROR") {
    console.error(prefix, message, attributes ?? "");
  } else if (severity === "WARN") {
    console.warn(prefix, message, attributes ?? "");
  } else {
    console.log(prefix, message, attributes ?? "");
  }

  // Check severity filter before emitting OTel records.
  const minSev = getMinSeverity();
  const currentRank = SEVERITY_RANK[severity];
  if (minSev > 0 && currentRank < minSev) {
    return;
  }

  // Fetch the logger LAZILY at emit time so we pick up the real
  // provider once the SDK has started.  The logs API returns a no-op
  // when no provider is registered, which is harmless.
  try {
    const logger = logs.getLogger("mcp-azure-storage");

    // Attach active context so the SDK can inject trace_id / span_id
    // for trace-to-log correlation.
    const activeContext = context.active();
    const activeSpan = trace.getSpan(activeContext);
    const spanContext = activeSpan?.spanContext();

    logger.emit({
      severityNumber: SEVERITY_NUMBER_MAP[severity],
      severityText: severity,
      body: message,
      attributes: attributes ?? {},
      context: activeContext,
      ...(spanContext
        ? {
            spanId: spanContext.spanId,
            traceId: spanContext.traceId,
            traceFlags: spanContext.traceFlags,
          }
        : {}),
    });
  } catch {
    // Swallow OTel emit errors -- never break the application.
  }
}

/** Log a DEBUG message. */
export function debug(
  message: string,
  attributes?: Record<string, string | number | boolean>,
): void {
  emit("DEBUG", message, attributes);
}

/** Log an INFO message. */
export function info(
  message: string,
  attributes?: Record<string, string | number | boolean>,
): void {
  emit("INFO", message, attributes);
}

/** Log a WARN message. */
export function warn(
  message: string,
  attributes?: Record<string, string | number | boolean>,
): void {
  emit("WARN", message, attributes);
}

/** Log an ERROR message. */
export function error(
  message: string,
  attributes?: Record<string, string | number | boolean>,
): void {
  emit("ERROR", message, attributes);
}
