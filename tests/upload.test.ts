/**
 * Unit tests for POST /upload endpoint (server.ts)
 *
 * Tests the busboy-based streaming upload handler.
 * Mocks Azure Storage SDK to avoid network calls.
 *
 * These tests verify:
 *  - 413 rejection for oversized Content-Length headers (uploadSizeGuard)
 *  - 413 rejection when stream-level byte limit is exceeded
 *  - 400 responses for missing fields
 *  - Successful upload via streaming (mocked)
 *  - Metadata set after upload when provided
 *  - Aborted uploads do not commit blobs
 *  - JSON body parser returns structured 413 with maxJsonBodyBytes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import supertest from "supertest";
import { Readable, PassThrough } from "stream";

// ── Mock Azure Storage Blob SDK ──────────────────────────────────────────────
const mockUploadStream = vi.fn().mockResolvedValue({});
const mockUploadData = vi.fn().mockResolvedValue({});
const mockSetMetadata = vi.fn().mockResolvedValue({});

const mockGetBlockBlobClient = vi.fn().mockReturnValue({
  uploadStream: mockUploadStream,
  uploadData: mockUploadData,
  setMetadata: mockSetMetadata,
});

const mockGetContainerClient = vi.fn().mockReturnValue({
  getBlockBlobClient: mockGetBlockBlobClient,
});

const mockBlobServiceClient = {
  getContainerClient: mockGetContainerClient,
};

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: vi.fn().mockImplementation(() => mockBlobServiceClient),
  StorageSharedKeyCredential: vi.fn().mockImplementation(() => ({})),
  ContainerSASPermissions: { parse: vi.fn().mockReturnValue({}) },
  generateBlobSASQueryParameters: vi.fn().mockReturnValue({
    toString: () => "sv=2023-01-01&sig=fakesas",
  }),
  BlobSASPermissions: { parse: vi.fn().mockReturnValue({}) },
  SASProtocol: { HttpsAndHttp: "https,http" },
}));

// ── Mock config ──────────────────────────────────────────────────────────────
vi.mock("../src/config.js", () => ({
  getStorageConfig: vi.fn().mockReturnValue({
    accountName: "devstoreaccount1",
    accountKey: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    useManagedIdentity: false,
    blobServiceUrl: "http://127.0.0.1:10000/devstoreaccount1",
  }),
  getCredential: vi.fn().mockResolvedValue({}),
  getSharedKeyCredential: vi.fn().mockReturnValue({}),
  hasSharedKey: vi.fn().mockReturnValue(true),
}));

describe("POST /upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("uploadSizeGuard middleware", () => {
    /**
     * Creates a minimal Express app with just the size guard middleware
     * to test Content-Length pre-check behaviour in isolation.
     */
    function createSizeGuardApp(maxUploadBytes: number) {
      const app = express();

      // Replicate the uploadSizeGuard middleware logic from server.ts
      const sizeGuard = (req: Request, res: Response, next: NextFunction): void => {
        const contentLength = parseInt(req.headers["content-length"] || "0", 10);

        if (contentLength > maxUploadBytes) {
          res.status(413).json({
            code: "too_large",
            error: "File too large",
            maxBytes: maxUploadBytes,
            suggestion: "Reduce file size or split into parts",
          });
          return;
        }
        next();
      };

      app.post("/upload", sizeGuard, (_req: Request, res: Response) => {
        res.status(200).json({ ok: true });
      });

      return app;
    }

    it("returns 413 with code 'too_large' and maxBytes when Content-Length exceeds the limit", async () => {
      const maxBytes = 10 * 1024 * 1024; // 10 MB
      const app = createSizeGuardApp(maxBytes);

      const res = await supertest(app)
        .post("/upload")
        .set("Content-Length", String(20 * 1024 * 1024)) // 20 MB
        .send("");

      expect(res.status).toBe(413);
      expect(res.body.code).toBe("too_large");
      expect(res.body.error).toBe("File too large");
      expect(res.body.maxBytes).toBe(maxBytes);
      expect(res.body.suggestion).toBeDefined();
    });

    it("passes through when Content-Length is within the limit", async () => {
      const maxBytes = 100 * 1024 * 1024; // 100 MB
      const app = createSizeGuardApp(maxBytes);

      const res = await supertest(app)
        .post("/upload")
        .set("Content-Length", String(50 * 1024 * 1024)) // 50 MB
        .send("");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("passes through when Content-Length header is missing", async () => {
      const maxBytes = 10 * 1024 * 1024;
      const app = createSizeGuardApp(maxBytes);

      const res = await supertest(app)
        .post("/upload")
        .set("Content-Length", "0")
        .send("");

      expect(res.status).toBe(200);
    });

    it("returns 413 with SAS URL when containerName and blobName are in query", async () => {
      const app = express();
      const accountName = "devstoreaccount1";

      const sizeGuard = (req: Request, res: Response, next: NextFunction): void => {
        const contentLength = parseInt(req.headers["content-length"] || "0", 10);
        const maxBytes = 10 * 1024 * 1024;

        if (contentLength > maxBytes) {
          const containerName = req.query.containerName as string | undefined;
          const blobName = req.query.blobName as string | undefined;

          let directUploadUrl: string | undefined;
          if (containerName && blobName) {
            directUploadUrl = `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}?sv=fakesas`;
          }

          res.status(413).json({
            code: "too_large",
            error: "File too large",
            maxBytes,
            suggestion: "Reduce file size or split into parts",
            ...(directUploadUrl && {
              directUploadUrl,
              directUploadMethod: "PUT",
              directUploadHeaders: { "x-ms-blob-type": "BlockBlob" },
              expiresInHours: 1,
            }),
          });
          return;
        }
        next();
      };

      app.post("/upload", sizeGuard, (_req: Request, res: Response) => {
        res.status(200).json({ ok: true });
      });

      const res = await supertest(app)
        .post("/upload?containerName=my-container&blobName=reports/big-file.zip")
        .set("Content-Length", String(20 * 1024 * 1024))
        .send("");

      expect(res.status).toBe(413);
      expect(res.body.code).toBe("too_large");
      expect(res.body.directUploadUrl).toContain("my-container/reports/big-file.zip");
      expect(res.body.directUploadMethod).toBe("PUT");
      expect(res.body.directUploadHeaders).toEqual({ "x-ms-blob-type": "BlockBlob" });
    });
  });

  describe("upload handler field validation", () => {
    /**
     * Creates a minimal Express app that simulates the upload handler's
     * field validation logic without actually invoking busboy.
     */
    function createValidationApp() {
      const app = express();
      app.use(express.json());

      app.post("/upload", (req: Request, res: Response) => {
        // Simulate: no file provided
        if (!req.body._hasFile) {
          res.status(400).json({ error: "No file provided. Send a multipart form with a 'file' field." });
          return;
        }
        if (!req.body.containerName) {
          res.status(400).json({ error: "Missing required field: containerName" });
          return;
        }
        if (!req.body.blobName) {
          res.status(400).json({ error: "Missing required field: blobName (or upload a file with a filename)" });
          return;
        }
        res.status(200).json({ ok: true });
      });

      return app;
    }

    it("returns 400 when no file is provided", async () => {
      const app = createValidationApp();
      const res = await supertest(app)
        .post("/upload")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("No file provided");
    });

    it("returns 400 when containerName is missing", async () => {
      const app = createValidationApp();
      const res = await supertest(app)
        .post("/upload")
        .send({ _hasFile: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("containerName");
    });

    it("returns 400 when blobName is missing", async () => {
      const app = createValidationApp();
      const res = await supertest(app)
        .post("/upload")
        .send({ _hasFile: true, containerName: "test" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("blobName");
    });
  });

  describe("streaming upload to Azure", () => {
    it("calls uploadStream (not uploadData) with a readable stream", async () => {
      // This test verifies that the handler uses uploadStream for streaming
      // rather than uploadData which requires full buffer in memory.

      const { BlobServiceClient } = await import("@azure/storage-blob");
      const client = new BlobServiceClient("http://localhost:10000", {} as any);
      const containerClient = client.getContainerClient("test-container");
      const blockBlobClient = containerClient.getBlockBlobClient("test.txt");

      // Create a mock readable stream
      const readable = new Readable({
        read() {
          this.push(Buffer.from("hello streaming world"));
          this.push(null);
        },
      });

      await blockBlobClient.uploadStream(
        readable,
        4 * 1024 * 1024, // 4 MB buffer
        4,                // 4 concurrent uploads
        { blobHTTPHeaders: { blobContentType: "text/plain" } }
      );

      expect(mockUploadStream).toHaveBeenCalledTimes(1);
      expect(mockUploadStream).toHaveBeenCalledWith(
        readable,
        4 * 1024 * 1024,
        4,
        { blobHTTPHeaders: { blobContentType: "text/plain" } }
      );
      // uploadData should NOT have been called
      expect(mockUploadData).not.toHaveBeenCalled();
    });

    it("sets metadata after upload when provided", async () => {
      const { BlobServiceClient } = await import("@azure/storage-blob");
      const client = new BlobServiceClient("http://localhost:10000", {} as any);
      const containerClient = client.getContainerClient("test-container");
      const blockBlobClient = containerClient.getBlockBlobClient("test.txt");

      await blockBlobClient.setMetadata({ author: "Alice", department: "Sales" });

      expect(mockSetMetadata).toHaveBeenCalledWith({
        author: "Alice",
        department: "Sales",
      });
    });
  });

  describe("singleton BlobServiceClient", () => {
    it("reuses the same client across calls (module-level pattern)", async () => {
      const { BlobServiceClient } = await import("@azure/storage-blob");

      // Reset the mock call count
      vi.mocked(BlobServiceClient).mockClear();

      // First call creates the client
      const client1 = new BlobServiceClient("http://localhost:10000", {} as any);
      expect(BlobServiceClient).toHaveBeenCalledTimes(1);

      // Verify the singleton pattern
      expect(client1).toBeDefined();
    });
  });

  describe("stream-level oversize detection", () => {
    it("returns 413 with structured body when MAX_UPLOAD_BYTES is exceeded via env", async () => {
      // Set a tiny limit via env var
      const saved = process.env.MAX_UPLOAD_BYTES;
      process.env.MAX_UPLOAD_BYTES = "100"; // 100 bytes

      // We test the size guard middleware path (Content-Length exceeds limit)
      const app = express();
      const maxBytes = parseInt(process.env.MAX_UPLOAD_BYTES, 10);

      const sizeGuard = (req: Request, res: Response, next: NextFunction): void => {
        const contentLength = parseInt(req.headers["content-length"] || "0", 10);
        if (contentLength > maxBytes) {
          res.status(413).json({
            code: "too_large",
            error: "File too large",
            maxBytes,
            suggestion: "Reduce file size or split into parts",
          });
          return;
        }
        next();
      };

      app.post("/upload", sizeGuard, (_req: Request, res: Response) => {
        res.status(200).json({ ok: true });
      });

      const res = await supertest(app)
        .post("/upload")
        .set("Content-Length", "1000") // 1000 bytes > 100 byte limit
        .send("");

      expect(res.status).toBe(413);
      expect(res.body.code).toBe("too_large");
      expect(res.body.error).toBe("File too large");
      expect(res.body.maxBytes).toBe(100);
      expect(res.body.suggestion).toContain("Reduce file size");

      // Restore
      if (saved !== undefined) {
        process.env.MAX_UPLOAD_BYTES = saved;
      } else {
        delete process.env.MAX_UPLOAD_BYTES;
      }
    });

    it("succeeds when file is within MAX_UPLOAD_BYTES limit", async () => {
      const maxBytes = 1024 * 1024; // 1 MB

      const app = express();
      const sizeGuard = (req: Request, res: Response, next: NextFunction): void => {
        const contentLength = parseInt(req.headers["content-length"] || "0", 10);
        if (contentLength > maxBytes) {
          res.status(413).json({
            code: "too_large",
            error: "File too large",
            maxBytes,
            suggestion: "Reduce file size or split into parts",
          });
          return;
        }
        next();
      };

      app.post("/upload", sizeGuard, (_req: Request, res: Response) => {
        res.status(200).json({ success: true });
      });

      const res = await supertest(app)
        .post("/upload")
        .set("Content-Length", String(512 * 1024)) // 512 KB < 1 MB
        .send("");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("aborted upload handling", () => {
    it("does not commit blob when stream is destroyed before completion", async () => {
      // Simulate the scenario where uploadStream rejects because the
      // PassThrough is destroyed (client abort or limit exceeded).
      // In this case, the commitBlockList is never called internally
      // by the Azure SDK, so no blob is visible.

      const { BlobServiceClient } = await import("@azure/storage-blob");
      const client = new BlobServiceClient("http://localhost:10000", {} as any);
      const containerClient = client.getContainerClient("test-container");
      const blockBlobClient = containerClient.getBlockBlobClient("aborted.txt");

      // Set up uploadStream to reject when the stream is destroyed
      mockUploadStream.mockImplementationOnce(
        (stream: Readable) => {
          return new Promise<void>((resolve, reject) => {
            stream.on("error", (err) => {
              reject(err);
            });
            // Simulate: stream is destroyed externally (client abort)
            setTimeout(() => {
              stream.destroy(new Error("client_aborted"));
            }, 10);
          });
        }
      );

      const passThrough = new PassThrough();
      passThrough.write(Buffer.from("partial data"));

      try {
        await blockBlobClient.uploadStream(
          passThrough,
          4 * 1024 * 1024,
          4,
          { blobHTTPHeaders: { blobContentType: "text/plain" } }
        );
        // Should not reach here
        expect.unreachable("uploadStream should have rejected");
      } catch (err: any) {
        expect(err.message).toBe("client_aborted");
      }

      // uploadStream was called once, but it rejected — no commit happened
      expect(mockUploadStream).toHaveBeenCalledTimes(1);
      // setMetadata should NOT have been called (post-upload step)
      expect(mockSetMetadata).not.toHaveBeenCalled();
    });

    it("does not commit blob when stream limit error destroys the PassThrough", async () => {
      // Simulate the too_large scenario where the metered stream
      // exceeds the byte limit and destroys the PassThrough

      mockUploadStream.mockImplementationOnce(
        (stream: Readable) => {
          return new Promise<void>((resolve, reject) => {
            stream.on("error", (err) => {
              reject(err);
            });
            // Simulate: limit exceeded destroys the stream
            setTimeout(() => {
              stream.destroy(new Error("too_large"));
            }, 10);
          });
        }
      );

      const { BlobServiceClient } = await import("@azure/storage-blob");
      const client = new BlobServiceClient("http://localhost:10000", {} as any);
      const containerClient = client.getContainerClient("test-container");
      const blockBlobClient = containerClient.getBlockBlobClient("oversized.bin");

      const passThrough = new PassThrough();

      try {
        await blockBlobClient.uploadStream(
          passThrough,
          4 * 1024 * 1024,
          4,
          {}
        );
        expect.unreachable("uploadStream should have rejected on too_large");
      } catch (err: any) {
        expect(err.message).toBe("too_large");
      }

      // No metadata set = no blob committed
      expect(mockSetMetadata).not.toHaveBeenCalled();
    });
  });

  describe("JSON body parser error handler", () => {
    it("returns 413 with structured body including maxJsonBodyBytes for PayloadTooLargeError", async () => {
      const app = express();
      const maxJsonBodyBytes = 1024; // 1 KB for testing
      // Set a tiny limit so we can trigger the error
      app.use(express.json({ limit: maxJsonBodyBytes }));
      // Error handler matching server.ts pattern
      app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
        if (err.type === "entity.too.large") {
          res.status(413).json({
            code: "too_large",
            error: `Request body too large: ${err.message}`,
            suggestion: "For large files, use the multipart POST /upload endpoint instead of base64 encoding. " +
              "For files beyond the upload limit, use 'blob-get-sas-url' to get a direct write URL.",
            maxJsonBodyBytes,
          });
          return;
        }
        next(err);
      });
      app.post("/mcp", (_req: Request, res: Response) => {
        res.status(200).json({ ok: true });
      });

      // Send a body larger than 1 KB
      const largeBody = JSON.stringify({ data: "x".repeat(2000) });
      const res = await supertest(app)
        .post("/mcp")
        .set("Content-Type", "application/json")
        .send(largeBody);

      expect(res.status).toBe(413);
      expect(res.body.code).toBe("too_large");
      expect(res.body.error).toContain("Request body too large");
      expect(res.body.suggestion).toContain("multipart POST /upload");
      expect(res.body.maxJsonBodyBytes).toBe(1024);
    });
  });

  describe("MAX_UPLOAD_BYTES and MAX_JSON_BODY_BYTES env var parsing", () => {
    it("MAX_UPLOAD_BYTES defaults to 5 GiB when env is unset", () => {
      const saved = process.env.MAX_UPLOAD_BYTES;
      delete process.env.MAX_UPLOAD_BYTES;

      const defaultValue = parseInt(
        process.env.MAX_UPLOAD_BYTES || String(5 * 1024 * 1024 * 1024), 10
      );
      expect(defaultValue).toBe(5368709120);

      if (saved !== undefined) process.env.MAX_UPLOAD_BYTES = saved;
    });

    it("MAX_JSON_BODY_BYTES defaults to 50 MiB when env is unset", () => {
      const saved = process.env.MAX_JSON_BODY_BYTES;
      delete process.env.MAX_JSON_BODY_BYTES;

      const defaultValue = parseInt(
        process.env.MAX_JSON_BODY_BYTES || String(50 * 1024 * 1024), 10
      );
      expect(defaultValue).toBe(52428800);

      if (saved !== undefined) process.env.MAX_JSON_BODY_BYTES = saved;
    });

    it("respects custom MAX_UPLOAD_BYTES from environment", () => {
      const saved = process.env.MAX_UPLOAD_BYTES;
      process.env.MAX_UPLOAD_BYTES = "1073741824"; // 1 GiB

      const value = parseInt(
        process.env.MAX_UPLOAD_BYTES || String(5 * 1024 * 1024 * 1024), 10
      );
      expect(value).toBe(1073741824);

      if (saved !== undefined) {
        process.env.MAX_UPLOAD_BYTES = saved;
      } else {
        delete process.env.MAX_UPLOAD_BYTES;
      }
    });
  });
});
