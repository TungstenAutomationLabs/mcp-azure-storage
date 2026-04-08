/**
 * Tests for the response format utility module.
 *
 * Verifies JSON, HTML, and Markdown output for:
 *  - Arrays of objects (table rendering)
 *  - Single objects (detail/definition list rendering)
 *  - Primitive values (code block rendering)
 *  - Title inclusion
 *  - HTML escaping
 *  - Markdown pipe escaping
 */

import { describe, it, expect } from "vitest";
import { formatResponse, toHtml, toMarkdown } from "../../src/utils/format.js";

describe("format utilities", () => {
  // ── formatResponse ────────────────────────────────────────────

  describe("formatResponse", () => {
    it("returns JSON by default", () => {
      const result = formatResponse({ success: true }, "json");
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });

    it("returns HTML when format is 'html'", () => {
      const result = formatResponse({ name: "test" }, "html", "My Title");
      const text = result.content[0].text;
      expect(text).toContain('<h3 class="mcp-title">My Title</h3>');
      expect(text).toContain('<dl class="mcp-detail">');
      expect(text).toContain("<dt>name</dt>");
      expect(text).toContain("<dd>test</dd>");
    });

    it("returns Markdown when format is 'md'", () => {
      const result = formatResponse({ name: "test" }, "md", "My Title");
      const text = result.content[0].text;
      expect(text).toContain("### My Title");
      expect(text).toContain("**name:** test");
    });

    it("defaults to JSON for undefined format", () => {
      const result = formatResponse({ ok: 1 }, undefined as any);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(1);
    });
  });

  // ── toHtml ────────────────────────────────────────────────────

  describe("toHtml", () => {
    it("renders array of objects as table", () => {
      const data = [
        { name: "alpha", size: 100 },
        { name: "beta", size: 200 },
      ];
      const html = toHtml(data);
      expect(html).toContain('<table class="mcp-table">');
      expect(html).toContain("<th>name</th>");
      expect(html).toContain("<th>size</th>");
      expect(html).toContain("<td>alpha</td>");
      expect(html).toContain("<td>200</td>");
      expect(html).toContain("</table>");
    });

    it("renders single object as definition list", () => {
      const data = { status: "ready", count: 42 };
      const html = toHtml(data);
      expect(html).toContain('<dl class="mcp-detail">');
      expect(html).toContain("<dt>status</dt>");
      expect(html).toContain("<dd>ready</dd>");
      expect(html).toContain("<dt>count</dt>");
      expect(html).toContain("<dd>42</dd>");
      expect(html).toContain("</dl>");
    });

    it("renders nested object values as pre blocks", () => {
      const data = { meta: { key: "value" } };
      const html = toHtml(data);
      expect(html).toContain('<pre class="mcp-nested">');
      expect(html).toContain("key");
    });

    it("renders primitive as pre block", () => {
      const html = toHtml(42);
      expect(html).toContain('<pre class="mcp-raw">42</pre>');
    });

    it("renders null as pre block", () => {
      const html = toHtml(null);
      expect(html).toContain('<pre class="mcp-raw">null</pre>');
    });

    it("escapes HTML special characters", () => {
      const data = { message: '<script>alert("xss")</script>' };
      const html = toHtml(data);
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
    });

    it("includes title when provided", () => {
      const html = toHtml({ ok: true }, "Results");
      expect(html).toContain('<h3 class="mcp-title">Results</h3>');
    });

    it("handles empty array", () => {
      const html = toHtml([]);
      expect(html).toContain('<pre class="mcp-raw">[]</pre>');
    });

    it("handles array of mixed types gracefully", () => {
      const html = toHtml([1, 2, 3]);
      expect(html).toContain('<pre class="mcp-raw">');
    });
  });

  // ── toMarkdown ────────────────────────────────────────────────

  describe("toMarkdown", () => {
    it("renders array of objects as GFM table", () => {
      const data = [
        { name: "alpha", size: 100 },
        { name: "beta", size: 200 },
      ];
      const md = toMarkdown(data);
      expect(md).toContain("| name | size |");
      expect(md).toContain("| --- | --- |");
      expect(md).toContain("| alpha | 100 |");
      expect(md).toContain("| beta | 200 |");
    });

    it("renders single object as bold key-value list", () => {
      const data = { status: "ready", count: 42 };
      const md = toMarkdown(data);
      expect(md).toContain("**status:** ready");
      expect(md).toContain("**count:** 42");
    });

    it("renders nested values as fenced code blocks", () => {
      const data = { meta: { key: "value" } };
      const md = toMarkdown(data);
      expect(md).toContain("**meta:**");
      expect(md).toContain("```json");
      expect(md).toContain('"key": "value"');
    });

    it("renders primitive as fenced code block", () => {
      const md = toMarkdown(true);
      expect(md).toContain("```json\ntrue\n```");
    });

    it("escapes pipe characters in table cells", () => {
      const data = [{ value: "a|b" }];
      const md = toMarkdown(data);
      expect(md).toContain("a\\|b");
    });

    it("includes title when provided", () => {
      const md = toMarkdown({ ok: true }, "Results");
      expect(md).toContain("### Results");
    });

    it("handles rows with different keys", () => {
      const data = [
        { name: "a", extra: "x" },
        { name: "b", other: "y" },
      ];
      const md = toMarkdown(data);
      // Should include all unique keys as columns
      expect(md).toContain("| name | extra | other |");
    });
  });
});
