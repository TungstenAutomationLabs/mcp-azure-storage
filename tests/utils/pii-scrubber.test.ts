/**
 * Unit tests for src/utils/pii-scrubber.ts
 *
 * Verifies PII scrubbing for blob names, container names, and URLs
 * used in OTel span attributes.
 */

import {
  hashSegment,
  scrubBlobName,
  scrubContainerName,
  scrubUrl,
  isPiiScrubEnabled,
  maybeScrubBlobName,
  maybeScrubContainerName,
  maybeScrubUrl,
} from "../../src/utils/pii-scrubber.js";

describe("pii-scrubber", () => {
  afterEach(() => {
    delete process.env.OTEL_SCRUB_PII;
  });

  // ── hashSegment ────────────────────────────────────────────────────────

  describe("hashSegment", () => {
    it("returns an 8-character hex string", () => {
      const result = hashSegment("test-value");
      expect(result).toHaveLength(8);
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });

    it("is deterministic (same input => same output)", () => {
      expect(hashSegment("john-doe")).toBe(hashSegment("john-doe"));
    });

    it("produces different hashes for different inputs", () => {
      expect(hashSegment("john-doe")).not.toBe(hashSegment("jane-doe"));
    });

    it("handles empty string", () => {
      const result = hashSegment("");
      expect(result).toHaveLength(8);
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  // ── scrubBlobName ──────────────────────────────────────────────────────

  describe("scrubBlobName", () => {
    it("hashes a simple filename and preserves extension", () => {
      const result = scrubBlobName("passport-scan.pdf");
      expect(result).toMatch(/^[0-9a-f]{8}\.pdf$/);
    });

    it("hashes each segment in a virtual directory path", () => {
      const result = scrubBlobName("clients/john-doe/report.csv");
      const parts = result.split("/");
      expect(parts).toHaveLength(3);
      expect(parts[0]).toMatch(/^[0-9a-f]{8}$/);
      expect(parts[1]).toMatch(/^[0-9a-f]{8}$/);
      expect(parts[2]).toMatch(/^[0-9a-f]{8}\.csv$/);
    });

    it("preserves trailing slash (directory markers)", () => {
      const result = scrubBlobName("data/archive/");
      expect(result.endsWith("/")).toBe(true);
      const parts = result.slice(0, -1).split("/");
      expect(parts).toHaveLength(2);
    });

    it("handles file with no extension", () => {
      const result = scrubBlobName("README");
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });

    it("handles dotfile (extension only, no stem)", () => {
      // ".gitignore" has dotIndex === 0, so it should hash the whole thing
      const result = scrubBlobName(".gitignore");
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });

    it("handles file with multiple dots", () => {
      const result = scrubBlobName("report.2024.q1.xlsx");
      // Should split on the LAST dot: stem="report.2024.q1", ext=".xlsx"
      expect(result).toMatch(/^[0-9a-f]{8}\.xlsx$/);
    });

    it("returns empty string for empty input", () => {
      expect(scrubBlobName("")).toBe("");
    });

    it("is deterministic", () => {
      expect(scrubBlobName("clients/john/report.pdf")).toBe(
        scrubBlobName("clients/john/report.pdf")
      );
    });

    it("produces different hashes for different blob names", () => {
      expect(scrubBlobName("john-doe.pdf")).not.toBe(
        scrubBlobName("jane-doe.pdf")
      );
    });
  });

  // ── scrubContainerName ─────────────────────────────────────────────────

  describe("scrubContainerName", () => {
    it("hashes the container name", () => {
      const result = scrubContainerName("my-data-2024");
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });

    it("returns empty for empty input", () => {
      expect(scrubContainerName("")).toBe("");
    });

    it("is deterministic", () => {
      expect(scrubContainerName("test")).toBe(scrubContainerName("test"));
    });
  });

  // ── scrubUrl ───────────────────────────────────────────────────────────

  describe("scrubUrl", () => {
    it("scrubs Azure Blob Storage URLs", () => {
      const url =
        "https://myaccount.blob.core.windows.net/docs/john-doe/passport.pdf?sv=2024";
      const result = scrubUrl(url);
      // Host preserved
      expect(result).toContain("https://myaccount.blob.core.windows.net/");
      // Container scrubbed (8 hex chars)
      const path = result.replace(
        "https://myaccount.blob.core.windows.net/",
        ""
      );
      const [containerAndPath, query] = path.split("?");
      const segments = containerAndPath.split("/");
      expect(segments[0]).toMatch(/^[0-9a-f]{8}$/); // container
      expect(segments[1]).toMatch(/^[0-9a-f]{8}$/); // john-doe
      expect(segments[2]).toMatch(/^[0-9a-f]{8}\.pdf$/); // passport.pdf
      // Query preserved
      expect(query).toBe("sv=2024");
    });

    it("scrubs Azure Blob Storage URLs without query string", () => {
      const url =
        "https://myaccount.blob.core.windows.net/container/file.txt";
      const result = scrubUrl(url);
      expect(result).toContain("https://myaccount.blob.core.windows.net/");
      expect(result).not.toContain("?");
      expect(result).toMatch(/\.txt$/);
    });

    it("returns non-Azure URLs unchanged", () => {
      const url = "https://example.com/api/data?key=value";
      expect(scrubUrl(url)).toBe(url);
    });

    it("returns empty for empty input", () => {
      expect(scrubUrl("")).toBe("");
    });

    it("handles container-only URLs (no blob path)", () => {
      // This pattern requires a blob path after the container, so
      // container-only URLs will not match and return unchanged
      const url =
        "https://myaccount.blob.core.windows.net/container";
      expect(scrubUrl(url)).toBe(url);
    });
  });

  // ── isPiiScrubEnabled ──────────────────────────────────────────────────

  describe("isPiiScrubEnabled", () => {
    it("returns true by default (env not set)", () => {
      delete process.env.OTEL_SCRUB_PII;
      expect(isPiiScrubEnabled()).toBe(true);
    });

    it('returns true when set to "true"', () => {
      process.env.OTEL_SCRUB_PII = "true";
      expect(isPiiScrubEnabled()).toBe(true);
    });

    it('returns false when set to "false"', () => {
      process.env.OTEL_SCRUB_PII = "false";
      expect(isPiiScrubEnabled()).toBe(false);
    });

    it('returns false when set to "0"', () => {
      process.env.OTEL_SCRUB_PII = "0";
      expect(isPiiScrubEnabled()).toBe(false);
    });

    it("is case-insensitive", () => {
      process.env.OTEL_SCRUB_PII = "FALSE";
      expect(isPiiScrubEnabled()).toBe(false);
    });

    it("trims whitespace", () => {
      process.env.OTEL_SCRUB_PII = "  false  ";
      expect(isPiiScrubEnabled()).toBe(false);
    });
  });

  // ── maybeScrub* conditional functions ───────────────────────────────────

  describe("conditional scrubbing", () => {
    it("scrubs when OTEL_SCRUB_PII is not set (default true)", () => {
      delete process.env.OTEL_SCRUB_PII;
      const result = maybeScrubBlobName("john-doe.pdf");
      expect(result).toMatch(/^[0-9a-f]{8}\.pdf$/);
    });

    it("does not scrub when OTEL_SCRUB_PII is false", () => {
      process.env.OTEL_SCRUB_PII = "false";
      expect(maybeScrubBlobName("john-doe.pdf")).toBe("john-doe.pdf");
      expect(maybeScrubContainerName("my-container")).toBe("my-container");
      expect(maybeScrubUrl("https://x.blob.core.windows.net/c/b.pdf")).toBe(
        "https://x.blob.core.windows.net/c/b.pdf"
      );
    });

    it("scrubs when OTEL_SCRUB_PII is true", () => {
      process.env.OTEL_SCRUB_PII = "true";
      const result = maybeScrubContainerName("my-container");
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });
  });
});
