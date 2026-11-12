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

/**
 * Split the disabled set into tools the server knows and a count of the rest.
 *
 * The known names are taken from the catalogue, not from DISABLED_TOOLS, so
 * reporting them never echoes the raw environment value.
 *
 * @param disabled - Parsed DISABLED_TOOLS set.
 * @param known - The server's catalogue of tool names.
 * @returns The disabled catalogue names (catalogue order) and the number of unknown entries.
 */
export function splitDisabledTools(
  disabled: ReadonlySet<string>,
  known: ReadonlySet<string>,
): { known: string[]; unknownCount: number } {
  const knownDisabled = [...known].filter((name) => disabled.has(name));
  return { known: knownDisabled, unknownCount: disabled.size - knownDisabled.length };
}
