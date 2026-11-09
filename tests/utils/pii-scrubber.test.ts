/**
 * Unit tests for src/utils/pii-scrubber.ts
 *
 * Verifies PII scrubbing by removal for blob names, container names,
 * and URLs used in OTel span attributes.
 *
 * Since v1.4.0, scrubbing uses removal (not hashing):
 *  - Blob names/paths => "[redacted]"
 *  - Container names => kept in plain text (or HMAC'd when key is set)
 *  - URLs => scheme + host + resource name only (paths and queries removed)
 */

import {
  hashSegment,
  scrubBlobName,
  scrubContainerName,
  scrubUrl,
  scrubUrlPath,
  isPiiScrubEnabled,
  maybeScrubBlobName,
  maybeScrubContainerName,
  maybeScrubUrl,
  hmacValue,
  getHmacKey,
  REDACTED_PLACEHOLDER,
} from "../../src/utils/pii-scrubber.js";

describe("pii-scrubber", () => {
  afterEach(() => {
    delete process.env.OTEL_SCRUB_PII;
    delete process.env.OTEL_SCRUB_HMAC_KEY;
  });

  // -- hashSegment (deprecated, returns placeholder) --------------------------

  describe("hashSegment (deprecated)", () => {
    it("returns the redacted placeholder regardless of input", () => {
      expect(hashSegment("test-value")).toBe(REDACTED_PLACEHOLDER);
      expect(hashSegment("john-doe")).toBe(REDACTED_PLACEHOLDER);
      expect(hashSegment("")).toBe(REDACTED_PLACEHOLDER);
    });
  });

  // -- scrubBlobName ----------------------------------------------------------

  describe("scrubBlobName", () => {
    it("returns the redacted placeholder for any blob name", () => {
      expect(scrubBlobName("passport-scan.pdf")).toBe(REDACTED_PLACEHOLDER);
    });

    it("returns the redacted placeholder for a virtual directory path", () => {
      expect(scrubBlobName("clients/john-doe/report.csv")).toBe(
        REDACTED_PLACEHOLDER
      );
    });

    it("returns the redacted placeholder for a directory marker", () => {
      expect(scrubBlobName("data/archive/")).toBe(REDACTED_PLACEHOLDER);
    });

    it("returns the redacted placeholder for a file with no extension", () => {
      expect(scrubBlobName("README")).toBe(REDACTED_PLACEHOLDER);
    });

    it("returns empty string for empty input", () => {
      expect(scrubBlobName("")).toBe("");
    });
  });

  // -- scrubContainerName -----------------------------------------------------

  describe("scrubContainerName", () => {
    it("keeps the container name in plain text by default", () => {
      expect(scrubContainerName("my-data-2024")).toBe("my-data-2024");
    });

    it("returns empty for empty input", () => {
      expect(scrubContainerName("")).toBe("");
    });

    it("HMAC's the name when OTEL_SCRUB_HMAC_KEY is set", () => {
      process.env.OTEL_SCRUB_HMAC_KEY = "test-secret-key";
      const result = scrubContainerName("my-data-2024");
      // Should be a 16-char hex string (HMAC output)
      expect(result).toMatch(/^[0-9a-f]{16}$/);
      expect(result).not.toBe("my-data-2024");
    });

    it("produces deterministic HMAC output", () => {
      process.env.OTEL_SCRUB_HMAC_KEY = "test-secret-key";
      expect(scrubContainerName("test")).toBe(scrubContainerName("test"));
    });

    it("produces different HMAC for different names", () => {
      process.env.OTEL_SCRUB_HMAC_KEY = "test-secret-key";
      expect(scrubContainerName("alpha")).not.toBe(
        scrubContainerName("beta")
      );
    });
  });

  // -- hmacValue --------------------------------------------------------------

  describe("hmacValue", () => {
    it("returns a 16-character hex string", () => {
      const result = hmacValue("test-value", "my-key");
      expect(result).toHaveLength(16);
      expect(result).toMatch(/^[0-9a-f]{16}$/);
    });

    it("is deterministic", () => {
      expect(hmacValue("test", "key")).toBe(hmacValue("test", "key"));
    });

    it("produces different output for different keys", () => {
      expect(hmacValue("test", "key-1")).not.toBe(
        hmacValue("test", "key-2")
      );
    });
  });

  // -- scrubUrl ---------------------------------------------------------------

  describe("scrubUrl", () => {
    it("keeps scheme + host + container for blob URLs, removes blob path and query", () => {
      const url =
        "https://myaccount.blob.core.windows.net/docs/john-doe/passport.pdf?sv=2024";
      const result = scrubUrl(url);
      expect(result).toBe("https://myaccount.blob.core.windows.net/docs");
    });

    it("keeps scheme + host + container for blob URLs without query", () => {
      const url =
        "https://myaccount.blob.core.windows.net/container/file.txt";
      const result = scrubUrl(url);
      expect(result).toBe(
        "https://myaccount.blob.core.windows.net/container"
      );
    });

    it("keeps scheme + host + queue name for queue URLs", () => {
      const url =
        "https://myaccount.queue.core.windows.net/my-queue/messages?visibilitytimeout=30";
      const result = scrubUrl(url);
      expect(result).toBe(
        "https://myaccount.queue.core.windows.net/my-queue"
      );
    });

    it("keeps scheme + host + table name for table URLs, strips entity keys", () => {
      const url =
        "https://myaccount.table.core.windows.net/MyTable(PartitionKey='sales',RowKey='order-001')";
      const result = scrubUrl(url);
      expect(result).toBe(
        "https://myaccount.table.core.windows.net/MyTable"
      );
    });

    it("keeps scheme + host + share name for file share URLs", () => {
      const url =
        "https://myaccount.file.core.windows.net/my-share/reports/2024/secret.pdf";
      const result = scrubUrl(url);
      expect(result).toBe(
        "https://myaccount.file.core.windows.net/my-share"
      );
    });

    it("returns non-Azure URLs unchanged", () => {
      const url = "https://example.com/api/data?key=value";
      expect(scrubUrl(url)).toBe(url);
    });

    it("returns empty for empty input", () => {
      expect(scrubUrl("")).toBe("");
    });

    it("handles container-only URLs (no blob path)", () => {
      const url =
        "https://myaccount.blob.core.windows.net/container";
      expect(scrubUrl(url)).toBe(url);
    });

    it("HMAC's the resource name when OTEL_SCRUB_HMAC_KEY is set", () => {
      process.env.OTEL_SCRUB_HMAC_KEY = "test-key";
      const url =
        "https://myaccount.blob.core.windows.net/container/path/to/file.pdf?sv=2024";
      const result = scrubUrl(url);
      // Resource name should be HMAC'd, not plain text
      expect(result).not.toContain("container");
      expect(result).toContain("https://myaccount.blob.core.windows.net/");
      // Should end with a 16-char hex HMAC
      const afterHost = result.replace(
        "https://myaccount.blob.core.windows.net/",
        ""
      );
      expect(afterHost).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  // -- scrubUrl: Azurite URLs -------------------------------------------------

  describe("scrubUrl (Azurite)", () => {
    it("handles Azurite URLs with devstoreaccount1 prefix", () => {
      const url =
        "http://127.0.0.1:10000/devstoreaccount1/my-container/path/to/blob.pdf?sv=2024";
      const result = scrubUrl(url);
      expect(result).toBe(
        "http://127.0.0.1:10000/devstoreaccount1/my-container"
      );
    });

    it("handles localhost Azurite URLs", () => {
      const url =
        "http://localhost:10000/devstoreaccount1/testcontainer/secret.txt";
      const result = scrubUrl(url);
      expect(result).toBe(
        "http://localhost:10000/devstoreaccount1/testcontainer"
      );
    });

    it("handles Azurite queue URLs", () => {
      const url =
        "http://127.0.0.1:10001/devstoreaccount1/my-queue/messages";
      const result = scrubUrl(url);
      expect(result).toBe(
        "http://127.0.0.1:10001/devstoreaccount1/my-queue"
      );
    });

    it("HMAC's Azurite resource names when OTEL_SCRUB_HMAC_KEY is set", () => {
      process.env.OTEL_SCRUB_HMAC_KEY = "test-key";
      const url =
        "http://127.0.0.1:10000/devstoreaccount1/my-container/blob.pdf";
      const result = scrubUrl(url);
      expect(result).toContain(
        "http://127.0.0.1:10000/devstoreaccount1/"
      );
      expect(result).not.toContain("my-container");
    });
  });

  // -- scrubUrlPath -----------------------------------------------------------

  describe("scrubUrlPath", () => {
    it("keeps only the resource name segment for blob paths", () => {
      const result = scrubUrlPath(
        "/container/path/to/blob.pdf",
        "myaccount.blob.core.windows.net"
      );
      expect(result).toBe("/container");
    });

    it("strips entity keys from table paths", () => {
      const result = scrubUrlPath(
        "/MyTable(PartitionKey='x',RowKey='y')",
        "myaccount.table.core.windows.net"
      );
      expect(result).toBe("/MyTable");
    });

    it("returns non-Azure paths unchanged", () => {
      const result = scrubUrlPath("/api/data", "example.com");
      expect(result).toBe("/api/data");
    });

    it("handles Azurite paths (account + resource)", () => {
      const result = scrubUrlPath(
        "/devstoreaccount1/container/blob.pdf",
        "127.0.0.1"
      );
      expect(result).toBe("/devstoreaccount1/container");
    });
  });

  // -- isPiiScrubEnabled ------------------------------------------------------

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

  // -- getHmacKey -------------------------------------------------------------

  describe("getHmacKey", () => {
    it("returns null when OTEL_SCRUB_HMAC_KEY is not set", () => {
      delete process.env.OTEL_SCRUB_HMAC_KEY;
      expect(getHmacKey()).toBeNull();
    });

    it("returns null when OTEL_SCRUB_HMAC_KEY is empty", () => {
      process.env.OTEL_SCRUB_HMAC_KEY = "";
      expect(getHmacKey()).toBeNull();
    });

    it("returns the key when set", () => {
      process.env.OTEL_SCRUB_HMAC_KEY = "my-secret";
      expect(getHmacKey()).toBe("my-secret");
    });
  });

  // -- maybeScrub* conditional functions --------------------------------------

  describe("conditional scrubbing", () => {
    it("scrubs when OTEL_SCRUB_PII is not set (default true)", () => {
      delete process.env.OTEL_SCRUB_PII;
      expect(maybeScrubBlobName("john-doe.pdf")).toBe(REDACTED_PLACEHOLDER);
    });

    it("does not scrub when OTEL_SCRUB_PII is false", () => {
      process.env.OTEL_SCRUB_PII = "false";
      expect(maybeScrubBlobName("john-doe.pdf")).toBe("john-doe.pdf");
      expect(maybeScrubContainerName("my-container")).toBe("my-container");
      expect(
        maybeScrubUrl("https://x.blob.core.windows.net/c/b.pdf")
      ).toBe("https://x.blob.core.windows.net/c/b.pdf");
    });

    it("scrubs blob names when OTEL_SCRUB_PII is true", () => {
      process.env.OTEL_SCRUB_PII = "true";
      expect(maybeScrubBlobName("secret-file.pdf")).toBe(
        REDACTED_PLACEHOLDER
      );
    });

    it("keeps container names in plain text when OTEL_SCRUB_PII is true", () => {
      process.env.OTEL_SCRUB_PII = "true";
      expect(maybeScrubContainerName("my-container")).toBe("my-container");
    });
  });
});
