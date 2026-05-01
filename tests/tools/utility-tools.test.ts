/**
 * Unit tests for src/tools/utility-tools.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Azure Storage Blob SDK (for SAS tools) ─────────────────────────
vi.mock("@azure/storage-blob", () => {
  return {
    StorageSharedKeyCredential: vi.fn().mockImplementation(() => ({})),
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
  extractToolJson,
  extractToolsList,
} from "../helpers/mcp-test-harness.js";
import { registerUtilityTools } from "../../src/tools/utility-tools.js";

function createUtilTestApp() {
  return createTestApp((server) => registerUtilityTools(server));
}

describe("utility-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tool registration", () => {
    it("registers 7 utility tools", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(app, toolListRequest()).expect(200);

      const tools = extractToolsList(res);
      expect(tools).toHaveLength(7);

      const names = tools.map((t: any) => t.name);
      expect(names).toContain("util-get-upload-url");
    });
  });

  describe("util-to-base64", () => {
    it("encodes text to base64", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-to-base64", { text: "hello world" })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.base64).toBe(Buffer.from("hello world").toString("base64"));
      expect(data.originalLength).toBe(11);
    });
  });

  describe("util-from-base64", () => {
    it("decodes base64 to text", async () => {
      const base64 = Buffer.from("hello world").toString("base64");
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-from-base64", { base64 })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.text).toBe("hello world");
      expect(data.decodedLength).toBe(11);
    });
  });

  describe("util-get-content-type", () => {
    it("returns correct MIME type for known extensions", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-get-content-type", { fileName: "report.pdf" })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.contentType).toBe("application/pdf");
    });

    it("returns octet-stream for unknown extensions", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-get-content-type", { fileName: "data.xyz" })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.contentType).toBe("application/octet-stream");
    });
  });

  describe("util-to-container-name", () => {
    it("sanitises email to valid container name", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-to-container-name", {
          input: "Tom.Coppock@example.com",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.containerName).toBe("tom-coppock-example-com");
      expect(data.containerName).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it("applies prefix when provided", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-to-container-name", {
          input: "project",
          prefix: "user-",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.containerName).toBe("user-project");
    });

    it("pads short names to 3 characters", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-to-container-name", { input: "a" })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.containerName.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("util-refresh-blob-sas", () => {
    it("generates a fresh SAS URL", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-refresh-blob-sas", {
          containerName: "test",
          blobName: "file.txt",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.url).toContain("test/file.txt");
      expect(data.url).toContain("fakesig");
      expect(data.sasToken).toBeDefined();
      expect(data.expiresOn).toBeDefined();
    });
  });

  describe("util-get-upload-url", () => {
    it("returns upload endpoint URL and instructions", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-get-upload-url", {})
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.uploadUrl).toContain("/upload");
      expect(data.method).toBe("POST");
      expect(data.contentType).toBe("multipart/form-data");
      expect(data.maxFileSize).toBe("100 MB");
      expect(data.fields).toBeDefined();
      expect(data.fields.file).toBeDefined();
      expect(data.fields.containerName).toBeDefined();
      expect(data.examples).toBeDefined();
      expect(data.examples.curl).toContain("/upload");
      expect(data.notes).toBeInstanceOf(Array);
    });
  });
});
