/**
 * Telemetry scrubbing tests -- verifies that PII is removed (not hashed)
 * from all telemetry exports: span URL attributes, log messages, and
 * error messages.
 *
 * Covers:
 *  - URL scrubbing for all four Azure Storage services (blob, queue, table, file)
 *  - Azurite emulator URL handling
 *  - HMAC mode for resource name correlation
 *  - Query string removal
 *  - Entity key removal from table URLs
 *  - Error message sanitisation (blob paths in Azure error messages)
 *  - Path scrubbing for url.path / http.target attributes
 *
 * @module tests/utils/telemetry-scrub
 */

import {
  scrubUrl,
  scrubUrlPath,
  scrubBlobName,
  scrubContainerName,
  scrubOutboundUrl,
  isStorageHost,
  hmacValue,
  isPiiScrubEnabled,
  getHmacKey,
  maybeScrubBlobName,
  maybeScrubUrl,
  REDACTED_PLACEHOLDER,
} from "../../src/utils/pii-scrubber.js";
import { sanitizeMessage } from "../../src/utils/errors.js";

describe("telemetry-scrub", () => {
  afterEach(() => {
    delete process.env.OTEL_SCRUB_PII;
    delete process.env.OTEL_SCRUB_HMAC_KEY;
  });

  // ========================================================================
  // URL scrubbing -- all four Azure Storage services
  // ========================================================================

  describe("URL scrubbing by service type", () => {
    describe("Blob service (*.blob.core.windows.net)", () => {
      it("removes blob path and query from blob URLs", () => {
        const url =
          "https://account.blob.core.windows.net/mycontainer/path/to/secret.pdf?sv=2024-01-01&sig=abc123";
        const result = scrubUrl(url);
        expect(result).toBe(
          "https://account.blob.core.windows.net/mycontainer"
        );
      });

      it("removes deeply nested blob paths", () => {
        const url =
          "https://account.blob.core.windows.net/docs/clients/john-doe/medical/scan.pdf";
        expect(scrubUrl(url)).toBe(
          "https://account.blob.core.windows.net/docs"
        );
      });

      it("preserves container-only URLs", () => {
        const url =
          "https://account.blob.core.windows.net/mycontainer";
        expect(scrubUrl(url)).toBe(url);
      });

      it("removes query-only from container URLs", () => {
        const url =
          "https://account.blob.core.windows.net/mycontainer?restype=container&comp=list";
        expect(scrubUrl(url)).toBe(
          "https://account.blob.core.windows.net/mycontainer"
        );
      });
    });

    describe("Queue service (*.queue.core.windows.net)", () => {
      it("removes message path and query from queue URLs", () => {
        const url =
          "https://account.queue.core.windows.net/my-queue/messages?visibilitytimeout=30&numofmessages=5";
        expect(scrubUrl(url)).toBe(
          "https://account.queue.core.windows.net/my-queue"
        );
      });

      it("removes message ID paths", () => {
        const url =
          "https://account.queue.core.windows.net/my-queue/messages/msg-id-123?popreceipt=abc";
        expect(scrubUrl(url)).toBe(
          "https://account.queue.core.windows.net/my-queue"
        );
      });
    });

    describe("Table service (*.table.core.windows.net)", () => {
      it("removes entity keys from table URLs", () => {
        const url =
          "https://account.table.core.windows.net/MyTable(PartitionKey='sales-region',RowKey='order-001')";
        expect(scrubUrl(url)).toBe(
          "https://account.table.core.windows.net/MyTable"
        );
      });

      it("removes OData query parameters", () => {
        const url =
          "https://account.table.core.windows.net/MyTable?$filter=PartitionKey%20eq%20'sales'&$top=10";
        expect(scrubUrl(url)).toBe(
          "https://account.table.core.windows.net/MyTable"
        );
      });

      it("handles table-only URLs without entity keys", () => {
        const url =
          "https://account.table.core.windows.net/MyTable";
        expect(scrubUrl(url)).toBe(url);
      });
    });

    describe("File share service (*.file.core.windows.net)", () => {
      it("removes file path and query from file share URLs", () => {
        const url =
          "https://account.file.core.windows.net/my-share/reports/2024/q1/confidential.xlsx";
        expect(scrubUrl(url)).toBe(
          "https://account.file.core.windows.net/my-share"
        );
      });

      it("removes directory listing query parameters", () => {
        const url =
          "https://account.file.core.windows.net/my-share?restype=directory&comp=list&prefix=reports";
        expect(scrubUrl(url)).toBe(
          "https://account.file.core.windows.net/my-share"
        );
      });
    });
  });

  // ========================================================================
  // Blob paths are removed, not hashed
  // ========================================================================

  describe("blob path removal (not hashing)", () => {
    it("returns a fixed placeholder, not a hash", () => {
      const result = scrubBlobName("clients/john-doe/passport-scan.pdf");
      expect(result).toBe(REDACTED_PLACEHOLDER);
      // Must NOT be an 8-char hex hash
      expect(result).not.toMatch(/^[0-9a-f]{8}$/);
    });

    it("does not preserve file extension", () => {
      const result = scrubBlobName("report.pdf");
      expect(result).not.toContain(".pdf");
      expect(result).toBe(REDACTED_PLACEHOLDER);
    });

    it("does not preserve directory structure", () => {
      const result = scrubBlobName("a/b/c/d.txt");
      expect(result).not.toContain("/");
      expect(result).toBe(REDACTED_PLACEHOLDER);
    });
  });

  // ========================================================================
  // Container/queue/table/share names -- preserved or HMAC'd
  // ========================================================================

  describe("resource name preservation", () => {
    it("keeps container names in plain text by default", () => {
      expect(scrubContainerName("my-data")).toBe("my-data");
    });

    it("keeps container names in URLs by default", () => {
      const url =
        "https://acct.blob.core.windows.net/my-data/blob.pdf";
      expect(scrubUrl(url)).toContain("my-data");
    });

    it("HMAC's container names when OTEL_SCRUB_HMAC_KEY is set", () => {
      process.env.OTEL_SCRUB_HMAC_KEY = "secret-123";
      const result = scrubContainerName("my-data");
      expect(result).not.toBe("my-data");
      expect(result).toMatch(/^[0-9a-f]{16}$/);
    });

    it("HMAC in URLs replaces the resource name", () => {
      process.env.OTEL_SCRUB_HMAC_KEY = "secret-123";
      const url =
        "https://acct.blob.core.windows.net/my-data/blob.pdf";
      const result = scrubUrl(url);
      expect(result).not.toContain("my-data");
      const resourcePart = result.replace(
        "https://acct.blob.core.windows.net/",
        ""
      );
      expect(resourcePart).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  // ========================================================================
  // Query strings -- completely removed
  // ========================================================================

  describe("query string removal", () => {
    it("removes SAS token query strings", () => {
      const url =
        "https://acct.blob.core.windows.net/container/blob.pdf?sv=2024-01-01&ss=b&sig=abc123def456";
      const result = scrubUrl(url);
      expect(result).not.toContain("?");
      expect(result).not.toContain("sig=");
      expect(result).not.toContain("sv=");
    });

    it("removes OData filter query strings", () => {
      const url =
        "https://acct.table.core.windows.net/MyTable?$filter=email%20eq%20'john@example.com'";
      const result = scrubUrl(url);
      expect(result).not.toContain("?");
      expect(result).not.toContain("john@example.com");
    });
  });

  // ========================================================================
  // Azurite URLs
  // ========================================================================

  describe("Azurite URL handling", () => {
    it("handles 127.0.0.1 Azurite blob URLs", () => {
      const url =
        "http://127.0.0.1:10000/devstoreaccount1/testcontainer/secret-blob.pdf?comp=block";
      expect(scrubUrl(url)).toBe(
        "http://127.0.0.1:10000/devstoreaccount1/testcontainer"
      );
    });

    it("handles localhost Azurite queue URLs", () => {
      const url =
        "http://localhost:10001/devstoreaccount1/my-queue/messages";
      expect(scrubUrl(url)).toBe(
        "http://localhost:10001/devstoreaccount1/my-queue"
      );
    });

    it("handles [::1] Azurite table URLs", () => {
      const url =
        "http://[::1]:10002/devstoreaccount1/MyTable(PartitionKey='x',RowKey='y')";
      expect(scrubUrl(url)).toBe(
        "http://[::1]:10002/devstoreaccount1/MyTable"
      );
    });

    it("preserves the Azurite account name prefix", () => {
      const url =
        "http://127.0.0.1:10000/devstoreaccount1/container/blob.pdf";
      const result = scrubUrl(url);
      expect(result).toContain("devstoreaccount1");
    });

    it("HMAC's resource names in Azurite URLs when key is set", () => {
      process.env.OTEL_SCRUB_HMAC_KEY = "azurite-key";
      const url =
        "http://127.0.0.1:10000/devstoreaccount1/testcontainer/blob.pdf";
      const result = scrubUrl(url);
      expect(result).toContain("devstoreaccount1");
      expect(result).not.toContain("testcontainer");
    });
  });

  // ========================================================================
  // HMAC mode
  // ========================================================================

  describe("HMAC mode with test key", () => {
    const testKey = "test-hmac-secret-2024";

    it("produces a deterministic 16-char hex HMAC", () => {
      const result = hmacValue("my-container", testKey);
      expect(result).toHaveLength(16);
      expect(result).toMatch(/^[0-9a-f]{16}$/);
      expect(hmacValue("my-container", testKey)).toBe(result);
    });

    it("different inputs produce different HMACs", () => {
      expect(hmacValue("container-a", testKey)).not.toBe(
        hmacValue("container-b", testKey)
      );
    });

    it("different keys produce different HMACs for the same input", () => {
      expect(hmacValue("same-input", "key-1")).not.toBe(
        hmacValue("same-input", "key-2")
      );
    });

    it("HMAC differs from unsalted SHA-256 hash", () => {
      // Verify that HMAC output is different from a plain hash
      const hmac = hmacValue("test", testKey);
      const { createHash } = require("crypto");
      const plainHash = createHash("sha256")
        .update("test")
        .digest("hex")
        .slice(0, 16);
      expect(hmac).not.toBe(plainHash);
    });
  });

  // ========================================================================
  // URL path scrubbing (url.path / http.target attributes)
  // ========================================================================

  describe("URL path scrubbing", () => {
    it("keeps only the resource name for blob paths", () => {
      expect(
        scrubUrlPath(
          "/container/path/to/blob.pdf",
          "acct.blob.core.windows.net"
        )
      ).toBe("/container");
    });

    it("keeps only the resource name for queue paths", () => {
      expect(
        scrubUrlPath(
          "/my-queue/messages",
          "acct.queue.core.windows.net"
        )
      ).toBe("/my-queue");
    });

    it("strips entity keys from table paths", () => {
      expect(
        scrubUrlPath(
          "/MyTable(PartitionKey='x',RowKey='y')",
          "acct.table.core.windows.net"
        )
      ).toBe("/MyTable");
    });

    it("keeps only the resource name for file share paths", () => {
      expect(
        scrubUrlPath(
          "/my-share/reports/secret.pdf",
          "acct.file.core.windows.net"
        )
      ).toBe("/my-share");
    });

    it("returns non-Azure paths unchanged", () => {
      expect(scrubUrlPath("/api/v1/data", "example.com")).toBe(
        "/api/v1/data"
      );
    });

    it("handles Azurite paths with account prefix", () => {
      expect(
        scrubUrlPath(
          "/devstoreaccount1/container/blob.pdf",
          "127.0.0.1"
        )
      ).toBe("/devstoreaccount1/container");
    });
  });

  // ========================================================================
  // Error message sanitisation
  // ========================================================================

  describe("error message sanitisation", () => {
    it("removes blob paths from Azure error messages", () => {
      const msg =
        'BlobNotFound: The specified blob https://acct.blob.core.windows.net/container/clients/john-doe/passport.pdf does not exist.';
      const result = sanitizeMessage(msg);
      expect(result).not.toContain("john-doe");
      expect(result).not.toContain("passport.pdf");
      // Container name is preserved (it is the resource name)
      expect(result).toContain("container");
    });

    it("removes SAS query strings entirely from error messages", () => {
      const msg =
        'Error: https://acct.blob.core.windows.net/c/b.pdf?sig=secret123&sv=2024';
      const result = sanitizeMessage(msg);
      // URL scrubbing removes the entire URL path and query beyond resource name
      expect(result).not.toContain("secret123");
      expect(result).not.toContain("sv=2024");
      expect(result).not.toContain("b.pdf");
      // The URL is truncated to scheme + host + resource name
      expect(result).toContain("https://acct.blob.core.windows.net/c");
    });

    it("removes entity keys from table error messages", () => {
      const msg =
        "EntityNotFound: https://acct.table.core.windows.net/MyTable(PartitionKey='john@example.com',RowKey='order-123')";
      const result = sanitizeMessage(msg);
      expect(result).not.toContain("john@example.com");
      expect(result).not.toContain("order-123");
      // Table name is preserved
      expect(result).toContain("MyTable");
    });

    it("removes file paths from file share error messages", () => {
      const msg =
        'FileNotFound: https://acct.file.core.windows.net/share/confidential/report.xlsx not found';
      const result = sanitizeMessage(msg);
      expect(result).not.toContain("confidential");
      expect(result).not.toContain("report.xlsx");
      // Share name is preserved
      expect(result).toContain("share");
    });
  });

  // ========================================================================
  // Integration: conditional scrubbing disabled
  // ========================================================================

  describe("scrubbing disabled (OTEL_SCRUB_PII=false)", () => {
    beforeEach(() => {
      process.env.OTEL_SCRUB_PII = "false";
    });

    it("preserves blob names verbatim", () => {
      expect(maybeScrubBlobName("john-doe.pdf")).toBe("john-doe.pdf");
    });

    it("preserves URLs verbatim", () => {
      const url =
        "https://acct.blob.core.windows.net/c/john-doe.pdf?sv=2024";
      expect(maybeScrubUrl(url)).toBe(url);
    });
  });

  // ========================================================================
  // Edge cases
  // ========================================================================

  describe("edge cases", () => {
    it("handles empty string input", () => {
      expect(scrubUrl("")).toBe("");
      expect(scrubBlobName("")).toBe("");
      expect(scrubContainerName("")).toBe("");
    });

    it("handles invalid URLs gracefully", () => {
      expect(scrubUrl("not-a-url")).toBe("not-a-url");
      expect(scrubUrl("://malformed")).toBe("://malformed");
    });

    it("handles URLs with no path segments", () => {
      expect(scrubUrl("https://acct.blob.core.windows.net")).toBe(
        "https://acct.blob.core.windows.net"
      );
      expect(scrubUrl("https://acct.blob.core.windows.net/")).toBe(
        "https://acct.blob.core.windows.net"
      );
    });

    it("does not modify non-Azure Storage URLs", () => {
      const urls = [
        "https://example.com/api/data?key=value",
        "https://google.com/search?q=test",
        "http://internal-service:8080/health",
      ];
      for (const url of urls) {
        expect(scrubUrl(url)).toBe(url);
      }
    });
  });

  // ========================================================================
  // Incoming request spans -- verify no tool argument leaks
  // ========================================================================

  describe("incoming request span safety", () => {
    it("POST /mcp route carries no tool arguments in the path", () => {
      // The MCP transport sends tool arguments in the JSON-RPC body,
      // not in the URL path. The HTTP instrumentation only captures
      // the route path (POST /mcp), not body content.
      // This test documents the invariant.
      const incomingPath = "/mcp";
      // Non-Azure host -- path is returned unchanged
      expect(scrubUrlPath(incomingPath, "localhost")).toBe("/mcp");
    });

    it("POST /upload route carries no blob names in the path", () => {
      const incomingPath = "/upload";
      expect(scrubUrlPath(incomingPath, "localhost")).toBe("/upload");
    });

    it("GET /health route carries no sensitive data", () => {
      const incomingPath = "/health";
      expect(scrubUrlPath(incomingPath, "localhost")).toBe("/health");
    });
  });

  // ========================================================================
  // scrubOutboundUrl -- non-storage URLs stripped to scheme+host
  // ========================================================================

  describe("scrubOutboundUrl", () => {
    it("strips path and query from non-storage URLs", () => {
      expect(
        scrubOutboundUrl("https://example.com/files/secret.pdf?token=abc")
      ).toBe("https://example.com");
    });

    it("strips port-bearing non-storage URLs to scheme+host:port", () => {
      expect(
        scrubOutboundUrl("http://cdn.example.com:8080/assets/image.png")
      ).toBe("http://cdn.example.com:8080");
    });

    it("delegates storage URLs to scrubUrl (keeps resource name)", () => {
      expect(
        scrubOutboundUrl(
          "https://acct.blob.core.windows.net/mycontainer/path/to/blob.pdf?sv=2024"
        )
      ).toBe("https://acct.blob.core.windows.net/mycontainer");
    });

    it("delegates Azurite URLs to scrubUrl (keeps account + resource)", () => {
      expect(
        scrubOutboundUrl(
          "http://127.0.0.1:10000/devstoreaccount1/container/blob.txt?comp=block"
        )
      ).toBe("http://127.0.0.1:10000/devstoreaccount1/container");
    });

    it("handles empty string input", () => {
      expect(scrubOutboundUrl("")).toBe("");
    });

    it("handles invalid URL input gracefully", () => {
      expect(scrubOutboundUrl("not-a-url")).toBe("not-a-url");
    });
  });

  // ========================================================================
  // isStorageHost -- identifies Azure, Azurite, and custom hosts
  // ========================================================================

  describe("isStorageHost", () => {
    it("recognises standard Azure blob host", () => {
      expect(isStorageHost("acct.blob.core.windows.net")).toBe(true);
    });

    it("recognises standard Azure queue host", () => {
      expect(isStorageHost("acct.queue.core.windows.net")).toBe(true);
    });

    it("recognises standard Azure table host", () => {
      expect(isStorageHost("acct.table.core.windows.net")).toBe(true);
    });

    it("recognises standard Azure file host", () => {
      expect(isStorageHost("acct.file.core.windows.net")).toBe(true);
    });

    it("recognises localhost as Azurite", () => {
      expect(isStorageHost("localhost")).toBe(true);
    });

    it("recognises 127.0.0.1 as Azurite", () => {
      expect(isStorageHost("127.0.0.1")).toBe(true);
    });

    it("recognises [::1] as Azurite", () => {
      expect(isStorageHost("[::1]")).toBe(true);
    });

    it("rejects non-storage hosts", () => {
      expect(isStorageHost("example.com")).toBe(false);
      expect(isStorageHost("google.com")).toBe(false);
      expect(isStorageHost("cdn.example.com")).toBe(false);
    });
  });

  // ========================================================================
  // Docker service name / custom host scrubbing
  // ========================================================================

  describe("Docker / custom storage host scrubbing", () => {
    it("scrubUrl handles Azurite Docker-style URLs (localhost)", () => {
      const url =
        "http://localhost:10000/devstoreaccount1/mycontainer/secret/file.txt?comp=block";
      expect(scrubUrl(url)).toBe(
        "http://localhost:10000/devstoreaccount1/mycontainer"
      );
    });

    it("scrubOutboundUrl strips non-storage Docker URLs to scheme+host", () => {
      expect(
        scrubOutboundUrl("http://redis:6379/some/command?key=value")
      ).toBe("http://redis:6379");
    });

    it("scrubUrlPath handles Azurite paths with account prefix", () => {
      const path = "/devstoreaccount1/container/blob/nested/path.txt";
      expect(scrubUrlPath(path, "127.0.0.1")).toBe(
        "/devstoreaccount1/container"
      );
    });
  });
});
