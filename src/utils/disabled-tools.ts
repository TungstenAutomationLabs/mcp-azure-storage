/**
 * DISABLED_TOOLS runtime gating utilities.
 *
 * Provides pure functions for parsing the DISABLED_TOOLS environment variable,
 * building structured forbidden error payloads, and checking tool names against
 * the disabled set. These are extracted into a separate module so they can be
 * imported by both the main server and unit tests without side effects.
 *
 * @module utils/disabled-tools
 */

/**
 * Parse the DISABLED_TOOLS environment variable into a normalised Set of
 * lowercase tool names. Trims whitespace and ignores empty entries.
 *
 * @param envValue - Raw env var value (may be undefined).
 * @returns A Set of canonical (lowercase) tool names to disable.
 */
export function parseDisabledTools(envValue: string | undefined): Set<string> {
  if (!envValue || !envValue.trim()) return new Set();
  return new Set(
    envValue
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
}

/**
 * Build the structured forbidden error payload for a disabled tool.
 *
 * @param toolName - The tool name as provided in the request (preserves casing).
 * @returns A structured error object with code, message, and data fields.
 */
export function buildDisabledToolError(toolName: string) {
  return {
    code: "forbidden" as const,
    error: `Tool '${toolName}' is disabled by server policy`,
    data: { reason: "disabled_tool" as const, toolName },
  };
}
