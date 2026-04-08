/**
 * Response format utilities — JSON, HTML fragment, and Markdown converters.
 *
 * Every tool that returns structured data can accept an optional `format`
 * parameter ("json" | "html" | "md") to control the output representation.
 *
 * **HTML output** produces minimal, semantic fragments (no `<html>`, `<head>`,
 * or `<body>` wrappers) designed to be embedded in Teams Adaptive Cards,
 * web chat bubbles, or Claude artifacts. All elements carry `data-mcp-*`
 * attributes and CSS classes so consumers can apply inline styles easily.
 *
 * **Markdown output** uses GFM (GitHub Flavoured Markdown) tables for arrays
 * and definition-style key–value lists for single objects.
 *
 * @module utils/format
 */

import { z } from "zod";

// ── Public Zod schema ────────────────────────────────────────────

/**
 * Reusable Zod schema for the `format` parameter on any tool.
 *
 * Usage in a tool definition:
 * ```ts
 * import { formatSchema, formatResponse } from "../utils/format.js";
 * server.tool("my-tool", "...", { ..., format: formatSchema }, async ({ ..., format }) => {
 *   return formatResponse(data, format);
 * });
 * ```
 */
export const formatSchema = z
  .enum(["json", "html", "md"])
  .optional()
  .default("json")
  .describe(
    "Response format: 'json' (default) returns structured JSON, " +
    "'html' returns a styled HTML fragment for embedding in chat UIs, " +
    "'md' returns a GitHub-Flavoured Markdown table or list."
  );

/** The union type derived from the schema. */
export type Format = z.infer<typeof formatSchema>;

// ── Main entry point ─────────────────────────────────────────────

/**
 * Format structured data and return an MCP tool response content array.
 *
 * @param data    - Any JSON-serialisable value (object, array, primitive).
 * @param format  - Target format: "json" | "html" | "md".
 * @param title   - Optional heading for HTML / Markdown output.
 * @returns MCP content array ready to be spread into a tool response.
 */
export function formatResponse(
  data: unknown,
  format: Format,
  title?: string
): { content: Array<{ type: "text"; text: string }> } {
  let text: string;

  switch (format) {
    case "html":
      text = toHtml(data, title);
      return { content: [{ type: "text", text }] };
    case "md":
      text = toMarkdown(data, title);
      return { content: [{ type: "text", text }] };
    case "json":
    default:
      text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text", text }] };
  }
}

// ── HTML conversion ──────────────────────────────────────────────

/**
 * Convert any JSON value to a minimal HTML fragment.
 *
 * - **Array of objects** → `<table class="mcp-table">` with column headers.
 * - **Single object**    → `<dl class="mcp-detail">` definition list.
 * - **Primitive / other** → `<pre class="mcp-raw">` code block.
 *
 * All output is a self-contained fragment — no `<html>`, `<head>`, or `<body>`.
 */
export function toHtml(data: unknown, title?: string): string {
  const parts: string[] = [];

  if (title) {
    parts.push(`<h3 class="mcp-title">${esc(title)}</h3>`);
  }

  if (Array.isArray(data) && data.length > 0 && isObjectArray(data)) {
    parts.push(arrayToHtmlTable(data));
  } else if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    parts.push(objectToHtmlDl(data as Record<string, unknown>));
  } else {
    parts.push(`<pre class="mcp-raw">${esc(JSON.stringify(data, null, 2))}</pre>`);
  }

  return parts.join("\n");
}

/** Render an array of flat objects as an HTML `<table>`. */
function arrayToHtmlTable(rows: Record<string, unknown>[]): string {
  // Gather all unique keys across every row for column headers
  const keys = uniqueKeys(rows);
  const lines: string[] = [];

  lines.push('<table class="mcp-table">');
  lines.push("  <thead><tr>");
  for (const key of keys) {
    lines.push(`    <th>${esc(key)}</th>`);
  }
  lines.push("  </tr></thead>");
  lines.push("  <tbody>");
  for (const row of rows) {
    lines.push("    <tr>");
    for (const key of keys) {
      const val = row[key];
      lines.push(`      <td>${esc(formatCell(val))}</td>`);
    }
    lines.push("    </tr>");
  }
  lines.push("  </tbody>");
  lines.push("</table>");

  return lines.join("\n");
}

/** Render a single object as an HTML `<dl>` definition list. */
function objectToHtmlDl(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push('<dl class="mcp-detail">');

  for (const [key, val] of Object.entries(obj)) {
    lines.push(`  <dt>${esc(key)}</dt>`);
    if (val !== null && typeof val === "object") {
      // Nested object/array → inline code block
      lines.push(`  <dd><pre class="mcp-nested">${esc(JSON.stringify(val, null, 2))}</pre></dd>`);
    } else {
      lines.push(`  <dd>${esc(formatCell(val))}</dd>`);
    }
  }

  lines.push("</dl>");
  return lines.join("\n");
}

// ── Markdown conversion ──────────────────────────────────────────

/**
 * Convert any JSON value to GitHub-Flavoured Markdown.
 *
 * - **Array of objects** → GFM table with `|` column separators.
 * - **Single object**    → Bold key–value list.
 * - **Primitive / other** → Fenced code block.
 */
export function toMarkdown(data: unknown, title?: string): string {
  const parts: string[] = [];

  if (title) {
    parts.push(`### ${title}\n`);
  }

  if (Array.isArray(data) && data.length > 0 && isObjectArray(data)) {
    parts.push(arrayToMdTable(data));
  } else if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    parts.push(objectToMdList(data as Record<string, unknown>));
  } else {
    parts.push("```json\n" + JSON.stringify(data, null, 2) + "\n```");
  }

  return parts.join("\n");
}

/** Render an array of flat objects as a GFM table. */
function arrayToMdTable(rows: Record<string, unknown>[]): string {
  const keys = uniqueKeys(rows);
  const lines: string[] = [];

  // Header row
  lines.push("| " + keys.map(escMd).join(" | ") + " |");
  // Separator row
  lines.push("| " + keys.map(() => "---").join(" | ") + " |");
  // Data rows
  for (const row of rows) {
    const cells = keys.map((k) => escMd(formatCell(row[k])));
    lines.push("| " + cells.join(" | ") + " |");
  }

  return lines.join("\n");
}

/** Render a single object as a Markdown key–value list. */
function objectToMdList(obj: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [key, val] of Object.entries(obj)) {
    if (val !== null && typeof val === "object") {
      lines.push(`**${escMd(key)}:**`);
      lines.push("```json\n" + JSON.stringify(val, null, 2) + "\n```");
    } else {
      lines.push(`**${escMd(key)}:** ${escMd(formatCell(val))}`);
    }
  }

  return lines.join("\n");
}

// ── Shared helpers ───────────────────────────────────────────────

/** Collect all unique object keys preserving first-seen order. */
function uniqueKeys(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      seen.add(key);
    }
  }
  return [...seen];
}

/** Check if every element is a non-null plain object. */
function isObjectArray(arr: unknown[]): arr is Record<string, unknown>[] {
  return arr.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
}

/** Format a cell value to a display string. */
function formatCell(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

/** Escape HTML special characters. */
function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape Markdown pipe characters inside table cells. */
function escMd(str: string): string {
  return str.replace(/\|/g, "\\|");
}
