/**
 * Unit tests for src/resources/fileshare-resources.ts
 *
 * Uses vi.hoisted() because fileshare-resources.ts creates its service client
 * at module scope, so mocks must be ready before module evaluation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";

const {
  mockListShares,
  mockListFilesAndDirectories,
  mockFileDownload,
  mockFileGetProperties,
} = vi.hoisted(() => ({
  mockListShares: vi.fn(),
  mockListFilesAndDirectories: vi.fn(),
  mockFileDownload: vi.fn(),
  mockFileGetProperties: vi.fn(),
}));

vi.mock("@azure/storage-file-share", () => {
  return {
    StorageSharedKeyCredential: vi.fn().mockImplementation(() => ({})),
    ShareServiceClient: vi.fn().mockImplementation(() => ({
      listShares: mockListShares,
      getShareClient: vi.fn().mockImplementation(() => ({
        getDirectoryClient: vi.fn().mockImplementation(() => ({
          listFilesAndDirectories: mockListFilesAndDirectories,
          getFileClient: vi.fn().mockImplementation(() => ({
            getProperties: mockFileGetProperties,
            download: mockFileDownload,
          })),
        })),
      })),
    })),
  };
});

import {
  createTestApp,
  mcpPost,
  resourceReadRequest,
  extractJsonRpcResponse,
  extractResourceContents,
} from "../helpers/mcp-test-harness.js";
import { registerFileShareResources } from "../../src/resources/fileshare-resources.js";

function createFileShareResourceApp() {
  return createTestApp((server) => registerFileShareResources(server));
}

describe("fileshare-resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("azure-fileshare:///shares (list shares)", () => {
    it("returns share list with index", async () => {
      mockListShares.mockImplementation(async function* () {
        yield { name: "documents" };
        yield { name: "backups" };
      });

      const app = createFileShareResourceApp();
      const res = await mcpPost(app, resourceReadRequest("azure-fileshare:///shares")).expect(200);

      const contents = extractResourceContents(res);
      const data = JSON.parse(contents[0].text);
      expect(data).toHaveLength(2);
      expect(data[0]).toEqual({ name: "documents", index: 1 });
    });
  });

  describe("fileshare-read-file resource", () => {
    it("rejects files exceeding MAX_DOWNLOAD_BYTES", async () => {
      const oversizeBytes = 51 * 1024 * 1024;
      mockFileGetProperties.mockResolvedValue({
        contentLength: oversizeBytes,
      });

      const app = createFileShareResourceApp();
      const res = await mcpPost(
        app,
        resourceReadRequest("azure-fileshare:///shares/docs/file/reports/huge.bin")
      ).expect(200);

      const body = extractJsonRpcResponse(res);
      const responseText = JSON.stringify(body);
      expect(responseText).toContain("exceeds");
    });

    it("returns text content for text files", async () => {
      mockFileGetProperties.mockResolvedValue({
        contentLength: 5,
        contentType: "text/plain",
      });

      const readable = new Readable({
        read() {
          this.push(Buffer.from("hello"));
          this.push(null);
        },
      });
      mockFileDownload.mockResolvedValue({
        readableStreamBody: readable,
        contentType: "text/plain",
      });

      const app = createFileShareResourceApp();
      const res = await mcpPost(
        app,
        resourceReadRequest("azure-fileshare:///shares/docs/file/reports/test.txt")
      ).expect(200);

      const contents = extractResourceContents(res);
      expect(contents[0].text).toBe("hello");
    });
  });

  describe("fileshare-file-properties resource", () => {
    it("returns file properties and metadata", async () => {
      mockFileGetProperties.mockResolvedValue({
        contentLength: 2048,
        contentType: "application/pdf",
        lastModified: new Date("2024-06-15"),
        fileCreatedOn: new Date("2024-01-01"),
        fileLastWriteOn: new Date("2024-06-15"),
        metadata: { dept: "sales" },
      });

      const app = createFileShareResourceApp();
      const res = await mcpPost(
        app,
        resourceReadRequest("azure-fileshare:///shares/docs/properties/reports/q1.pdf")
      ).expect(200);

      const contents = extractResourceContents(res);
      const data = JSON.parse(contents[0].text);
      expect(data.name).toBe("q1.pdf");
      expect(data.contentLength).toBe(2048);
      expect(data.metadata.dept).toBe("sales");
    });
  });
});
