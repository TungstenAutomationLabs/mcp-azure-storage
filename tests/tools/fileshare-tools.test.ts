/**
 * Unit tests for src/tools/fileshare-tools.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";

// ── Mock Azure Storage File Share SDK ────────────────────────────────────
const mockListShares = vi.fn();
const mockShareExists = vi.fn();
const mockShareCreate = vi.fn();
const mockShareDelete = vi.fn();
const mockDirExists = vi.fn();
const mockDirCreate = vi.fn();
const mockDirDelete = vi.fn();
const mockListFilesAndDirectories = vi.fn();
const mockFileCreate = vi.fn();
const mockFileUploadRange = vi.fn();
const mockFileDownload = vi.fn();
const mockFileDelete = vi.fn();
const mockFileGetProperties = vi.fn();

const mockGetFileClient = vi.fn().mockImplementation(() => ({
  create: mockFileCreate,
  uploadRange: mockFileUploadRange,
  download: mockFileDownload,
  delete: mockFileDelete,
  getProperties: mockFileGetProperties,
}));

const mockGetDirectoryClient = vi.fn().mockImplementation(() => ({
  exists: mockDirExists,
  create: mockDirCreate,
  delete: mockDirDelete,
  listFilesAndDirectories: mockListFilesAndDirectories,
  getFileClient: mockGetFileClient,
}));

const mockRootDirectoryClient = {
  listFilesAndDirectories: mockListFilesAndDirectories,
  getFileClient: mockGetFileClient,
};

vi.mock("@azure/storage-file-share", () => {
  return {
    StorageSharedKeyCredential: vi.fn().mockImplementation(() => ({})),
    ShareServiceClient: vi.fn().mockImplementation(() => ({
      listShares: mockListShares,
      getShareClient: vi.fn().mockImplementation(() => ({
        exists: mockShareExists,
        create: mockShareCreate,
        delete: mockShareDelete,
        getDirectoryClient: mockGetDirectoryClient,
        rootDirectoryClient: mockRootDirectoryClient,
      })),
    })),
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
import { registerFileShareTools } from "../../src/tools/fileshare-tools.js";

function createFileShareTestApp() {
  return createTestApp((server) => registerFileShareTools(server));
}

describe("fileshare-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tool registration", () => {
    it("registers 10 fileshare tools", async () => {
      const app = createFileShareTestApp();
      const res = await mcpPost(app, toolListRequest()).expect(200);

      const tools = extractToolsList(res);
      expect(tools).toHaveLength(10);
    });
  });

  describe("fileshare-list-shares", () => {
    it("returns shares with names and properties", async () => {
      mockListShares.mockImplementation(async function* () {
        yield {
          name: "documents",
          properties: { quota: 100, lastModified: "2024-01-01" },
        };
      });

      const app = createFileShareTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("fileshare-list-shares")
      ).expect(200);

      const data = extractToolJson(res);
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("documents");
    });
  });

  describe("fileshare-create-share", () => {
    it("creates share when it does not exist", async () => {
      mockShareExists.mockResolvedValue(false);
      mockShareCreate.mockResolvedValue({});

      const app = createFileShareTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("fileshare-create-share", { shareName: "new-share" })
      ).expect(200);

      const text = extractToolText(res);
      expect(text).toContain("created successfully");
      expect(mockShareCreate).toHaveBeenCalled();
    });

    it("reports share already exists", async () => {
      mockShareExists.mockResolvedValue(true);

      const app = createFileShareTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("fileshare-create-share", { shareName: "existing-share" })
      ).expect(200);

      const text = extractToolText(res);
      expect(text).toContain("already exists");
    });
  });

  describe("fileshare-list", () => {
    it("lists files and directories at root", async () => {
      mockListFilesAndDirectories.mockImplementation(async function* () {
        yield { kind: "directory", name: "reports" };
        yield {
          kind: "file",
          name: "readme.txt",
          properties: { contentLength: 256, lastModified: new Date() },
        };
      });

      const app = createFileShareTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("fileshare-list", {
          shareName: "docs",
          directoryPath: "",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.items).toHaveLength(2);
      expect(data.items[0].kind).toBe("directory");
      expect(data.items[1].kind).toBe("file");
      expect(data.items[1].contentLength).toBe(256);
    });
  });

  describe("fileshare-upload-file", () => {
    it("uploads base64 content to a directory", async () => {
      mockDirExists.mockResolvedValue(true);
      mockFileCreate.mockResolvedValue({});
      mockFileUploadRange.mockResolvedValue({});

      const content = Buffer.from("hello file").toString("base64");
      const app = createFileShareTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("fileshare-upload-file", {
          shareName: "docs",
          directoryPath: "reports",
          fileName: "test.txt",
          contentBase64: content,
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.success).toBe(true);
      expect(data.fileName).toBe("test.txt");
      expect(data.size).toBe(10);
    });
  });

  describe("fileshare-read-file", () => {
    it("returns base64 file content", async () => {
      const fileContent = Buffer.from("file content");
      const readable = new Readable({
        read() {
          this.push(fileContent);
          this.push(null);
        },
      });

      mockFileDownload.mockResolvedValue({
        readableStreamBody: readable,
        contentType: "text/plain",
      });

      const app = createFileShareTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("fileshare-read-file", {
          shareName: "docs",
          directoryPath: "reports",
          fileName: "test.txt",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.fileName).toBe("test.txt");
      expect(data.contentBase64).toBe(fileContent.toString("base64"));
    });
  });

  describe("fileshare-get-file-properties", () => {
    it("returns file metadata and properties", async () => {
      mockFileGetProperties.mockResolvedValue({
        contentLength: 1024,
        contentType: "application/pdf",
        lastModified: new Date("2024-06-15"),
        fileCreatedOn: new Date("2024-01-01"),
        metadata: { department: "sales" },
      });

      const app = createFileShareTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("fileshare-get-file-properties", {
          shareName: "docs",
          directoryPath: "reports",
          fileName: "report.pdf",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.fileName).toBe("report.pdf");
      expect(data.contentLength).toBe(1024);
      expect(data.contentType).toBe("application/pdf");
      expect(data.metadata.department).toBe("sales");
    });
  });
});
