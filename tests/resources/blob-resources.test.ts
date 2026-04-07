/**
 * Unit tests for src/resources/blob-resources.ts
 *
 * Tests MAX_LIST_ITEMS cap and MAX_DOWNLOAD_BYTES guard.
 * Uses vi.hoisted() because blob-resources.ts creates its service client
 * at module scope, so mocks must be ready before module evaluation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";

// ── Mock Azure Storage Blob SDK ──────────────────────────────────────────
// vi.hoisted ensures these are initialized before vi.mock factory runs
const {
  mockListContainers,
  mockListBlobsFlat,
  mockGetProperties,
  mockBlobDownload,
  mockContainerGetProperties,
} = vi.hoisted(() => ({
  mockListContainers: vi.fn(),
  mockListBlobsFlat: vi.fn(),
  mockGetProperties: vi.fn(),
  mockBlobDownload: vi.fn(),
  mockContainerGetProperties: vi.fn(),
}));

vi.mock("@azure/storage-blob", () => {
  return {
    StorageSharedKeyCredential: vi.fn().mockImplementation(() => ({})),
    BlobServiceClient: vi.fn().mockImplementation(() => ({
      listContainers: mockListContainers,
      getContainerClient: vi.fn().mockImplementation(() => ({
        listBlobsFlat: mockListBlobsFlat,
        getProperties: mockContainerGetProperties,
        getBlobClient: vi.fn().mockImplementation(() => ({
          getProperties: mockGetProperties,
          download: mockBlobDownload,
        })),
      })),
    })),
  };
});

import {
  createTestApp,
  mcpPost,
  resourceListRequest,
  resourceReadRequest,
  extractJsonRpcResponse,
  extractResourceContents,
  extractResourcesList,
} from "../helpers/mcp-test-harness.js";
import { registerBlobResources } from "../../src/resources/blob-resources.js";

function createBlobResourceApp() {
  return createTestApp((server) => registerBlobResources(server));
}

describe("blob-resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("resource registration", () => {
    it("registers blob resources", async () => {
      const app = createBlobResourceApp();
      const res = await mcpPost(app, resourceListRequest()).expect(200);

      const resources = extractResourcesList(res);
      expect(resources).toBeDefined();
      expect(resources.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("azure-blob:///containers (list containers)", () => {
    it("returns container list", async () => {
      mockListContainers.mockImplementation(async function* () {
        yield { name: "container-a" };
        yield { name: "container-b" };
      });

      const app = createBlobResourceApp();
      const res = await mcpPost(app, resourceReadRequest("azure-blob:///containers")).expect(200);

      const contents = extractResourceContents(res);
      expect(contents.length).toBe(1);

      const data = JSON.parse(contents[0].text);
      expect(data).toHaveLength(2);
      expect(data[0].name).toBe("container-a");
      expect(data[0].index).toBe(1);
    });

    it("caps list at MAX_LIST_ITEMS (500)", async () => {
      mockListContainers.mockImplementation(async function* () {
        for (let i = 0; i < 600; i++) {
          yield { name: `container-${i}` };
        }
      });

      const app = createBlobResourceApp();
      const res = await mcpPost(app, resourceReadRequest("azure-blob:///containers")).expect(200);

      const contents = extractResourceContents(res);
      const data = JSON.parse(contents[0].text);
      expect(data.length).toBeLessThanOrEqual(500);
    });
  });

  describe("azure-blob:///containers/{name}/blobs/{blobName} (read blob)", () => {
    it("returns text content for text blobs", async () => {
      mockGetProperties.mockResolvedValue({ contentLength: 11 });

      const readable = new Readable({
        read() {
          this.push(Buffer.from("hello world"));
          this.push(null);
        },
      });
      mockBlobDownload.mockResolvedValue({
        readableStreamBody: readable,
        contentType: "text/plain",
      });

      const app = createBlobResourceApp();
      const res = await mcpPost(
        app,
        resourceReadRequest("azure-blob:///containers/test/blobs/hello.txt")
      ).expect(200);

      const contents = extractResourceContents(res);
      expect(contents[0].text).toBe("hello world");
      expect(contents[0].mimeType).toBe("text/plain");
    });

    it("returns base64 for binary blobs", async () => {
      mockGetProperties.mockResolvedValue({ contentLength: 4 });

      const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
      const readable = new Readable({
        read() {
          this.push(binaryData);
          this.push(null);
        },
      });
      mockBlobDownload.mockResolvedValue({
        readableStreamBody: readable,
        contentType: "image/png",
      });

      const app = createBlobResourceApp();
      const res = await mcpPost(
        app,
        resourceReadRequest("azure-blob:///containers/test/blobs/image.png")
      ).expect(200);

      const contents = extractResourceContents(res);
      expect(contents[0].blob).toBe(binaryData.toString("base64"));
    });

    it("rejects blobs exceeding MAX_DOWNLOAD_BYTES (50 MiB)", async () => {
      const oversizeBytes = 51 * 1024 * 1024; // 51 MiB
      mockGetProperties.mockResolvedValue({ contentLength: oversizeBytes });

      const app = createBlobResourceApp();
      const res = await mcpPost(
        app,
        resourceReadRequest("azure-blob:///containers/test/blobs/huge.bin")
      ).expect(200);

      const body = extractJsonRpcResponse(res);
      const responseText = JSON.stringify(body);
      expect(responseText).toContain("exceeds");
    });
  });
});
