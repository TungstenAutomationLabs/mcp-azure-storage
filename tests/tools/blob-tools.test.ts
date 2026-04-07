/**
 * Unit tests for src/tools/blob-tools.ts
 *
 * Mocks the entire @azure/storage-blob module to avoid any network calls.
 * Tests tool registration and handler behaviour via the MCP test harness.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";

// ── Mock Azure Storage Blob SDK ──────────────────────────────────────────
const mockListContainers = vi.fn();
const mockExists = vi.fn();
const mockCreate = vi.fn();
const mockDelete = vi.fn();
const mockListBlobsFlat = vi.fn();
const mockUploadData = vi.fn();
const mockSetMetadata = vi.fn();
const mockBlobDownload = vi.fn();
const mockBlobDelete = vi.fn();
const mockBlobSetMetadata = vi.fn();
const mockGetProperties = vi.fn();

vi.mock("@azure/storage-blob", () => {
  return {
    StorageSharedKeyCredential: vi.fn().mockImplementation(() => ({})),
    BlobServiceClient: vi.fn().mockImplementation(() => ({
      listContainers: mockListContainers,
      getContainerClient: vi.fn().mockImplementation(() => ({
        exists: mockExists,
        create: mockCreate,
        delete: mockDelete,
        listBlobsFlat: mockListBlobsFlat,
        getBlockBlobClient: vi.fn().mockImplementation(() => ({
          uploadData: mockUploadData,
          setMetadata: mockSetMetadata,
          delete: mockBlobDelete,
        })),
        getBlobClient: vi.fn().mockImplementation(() => ({
          download: mockBlobDownload,
          setMetadata: mockBlobSetMetadata,
          getProperties: mockGetProperties,
        })),
      })),
    })),
    generateBlobSASQueryParameters: vi.fn().mockReturnValue({
      toString: () => "sv=2023-01-01&sig=fakesig",
    }),
    BlobSASPermissions: { parse: vi.fn().mockReturnValue({}) },
    ContainerSASPermissions: { parse: vi.fn().mockReturnValue({}) },
    SASProtocol: { HttpsAndHttp: "https,http" },
  };
});

import {
  createTestApp,
  mcpPost,
  toolCallRequest,
  toolListRequest,
  extractToolText,
  extractToolJson,
  extractToolsList,
} from "../helpers/mcp-test-harness.js";
import { registerBlobTools } from "../../src/tools/blob-tools.js";

function createBlobTestApp() {
  return createTestApp((server) => registerBlobTools(server));
}

describe("blob-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tool registration", () => {
    it("registers 10 blob tools", async () => {
      const app = createBlobTestApp();
      const res = await mcpPost(app, toolListRequest()).expect(200);

      const tools = extractToolsList(res);
      expect(tools.length).toBe(10);

      const names = tools.map((t: any) => t.name);
      expect(names).toContain("blob-container-create");
      expect(names).toContain("blob-read");
      expect(names).toContain("blob-create");
      expect(names).toContain("blob-get-sas-url");
    });
  });

  // blob-container-list removed — use azure-blob:///containers resource instead

  describe("blob-container-create", () => {
    it("creates container when it does not exist", async () => {
      mockExists.mockResolvedValue(false);
      mockCreate.mockResolvedValue({});

      const app = createBlobTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("blob-container-create", {
          containerName: "new-container",
        })
      ).expect(200);

      const text = extractToolText(res);
      expect(text).toContain("created successfully");
      expect(mockCreate).toHaveBeenCalled();
    });

    it("reports container already exists", async () => {
      mockExists.mockResolvedValue(true);

      const app = createBlobTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("blob-container-create", {
          containerName: "existing-container",
        })
      ).expect(200);

      const text = extractToolText(res);
      expect(text).toContain("already exists");
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe("blob-read", () => {
    it("returns base64 content by default", async () => {
      const content = Buffer.from("hello world");
      const readable = new Readable({
        read() {
          this.push(content);
          this.push(null);
        },
      });

      mockBlobDownload.mockResolvedValue({
        readableStreamBody: readable,
        contentType: "text/plain",
      });

      const app = createBlobTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("blob-read", {
          containerName: "test",
          blobName: "hello.txt",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.blobName).toBe("hello.txt");
      expect(data.contentType).toBe("text/plain");
      expect(data.contentBase64).toBe(content.toString("base64"));
      expect(data.size).toBe(11);
    });

    it("returns SAS URL when returnUrl=true", async () => {
      const app = createBlobTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("blob-read", {
          containerName: "test",
          blobName: "hello.txt",
          returnUrl: true,
          sasExpiryHours: 12,
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.url).toContain("devstoreaccount1");
      expect(data.url).toContain("fakesig");
      expect(data.expiresInHours).toBe(12);
    });
  });

  describe("blob-create", () => {
    it("uploads base64 content", async () => {
      mockUploadData.mockResolvedValue({});

      const content = Buffer.from("test content").toString("base64");
      const app = createBlobTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("blob-create", {
          containerName: "test",
          blobName: "doc.txt",
          contentBase64: content,
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.success).toBe(true);
      expect(data.blobName).toBe("doc.txt");
      expect(data.contentType).toBe("text/plain");
      expect(data.size).toBe(12);
      expect(mockUploadData).toHaveBeenCalled();
    });

    it("sets metadata when provided", async () => {
      mockUploadData.mockResolvedValue({});
      mockSetMetadata.mockResolvedValue({});

      const content = Buffer.from("x").toString("base64");
      const app = createBlobTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("blob-create", {
          containerName: "test",
          blobName: "doc.txt",
          contentBase64: content,
          metadata: { author: "Alice" },
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.metadataSet).toBe(1);
      expect(mockSetMetadata).toHaveBeenCalledWith({ author: "Alice" });
    });
  });

  describe("blob-delete", () => {
    it("deletes blob with snapshots", async () => {
      mockBlobDelete.mockResolvedValue({});

      const app = createBlobTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("blob-delete", {
          containerName: "test",
          blobName: "old.txt",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.success).toBe(true);
      expect(data.deleted).toBe("old.txt");
    });
  });

  describe("blob-get-sas-url", () => {
    it("returns SAS URL with token and expiry", async () => {
      const app = createBlobTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("blob-get-sas-url", {
          containerName: "test",
          blobName: "file.pdf",
          expiryHours: 6,
          permissions: "r",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.url).toContain("test/file.pdf");
      expect(data.sasToken).toBeDefined();
      expect(data.expiresOn).toBeDefined();
    });
  });
});
