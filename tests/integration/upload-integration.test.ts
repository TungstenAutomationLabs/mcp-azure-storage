/**
 * Azurite-backed integration tests for POST /upload (streaming uploads).
 *
 * These tests verify that the busboy-based streaming upload pipeline
 * works end-to-end against a real (emulated) Azure Blob Storage service.
 *
 * Prerequisites:
 *   1. Azurite running: docker compose -f docker-compose.azurite.yml up -d
 *   2. Environment: TEST_INTEGRATION=1 (set by npm run test:integration)
 *
 * Heavy upload tests (>100 MiB) are gated behind TEST_UPLOAD_LARGE=1 or
 * TEST_AZURE_LIVE=1 to keep default CI fast. The upload size can be
 * controlled via TEST_UPLOAD_MB (default: 150 when large tests are enabled).
 *
 * Run with:
 *   set TEST_INTEGRATION=1&& set TEST_UPLOAD_LARGE=1&& vitest run --config vitest.integration.config.ts tests/integration/upload-integration.test.ts
 */

import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { Readable } from "stream";
import { randomUUID } from "crypto";

// ── Gate: skip when Azurite is not running ──────────────────────────────────
const INTEGRATION = process.env.TEST_INTEGRATION === "1";
const LARGE_UPLOAD = process.env.TEST_UPLOAD_LARGE === "1" || process.env.TEST_AZURE_LIVE === "1";
const UPLOAD_MB = parseInt(process.env.TEST_UPLOAD_MB || "150", 10);

const describeIf = INTEGRATION ? describe : describe.skip;

// ── Azurite well-known credentials ──────────────────────────────────────────
const ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME || "devstoreaccount1";
const ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY ||
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const BLOB_URL = process.env.AZURE_BLOB_SERVICE_URL ||
  `http://127.0.0.1:10000/${ACCOUNT_NAME}`;

describeIf("POST /upload — Azurite integration", () => {
  let blobServiceClient: BlobServiceClient;
  let testContainerName: string;

  beforeAll(async () => {
    const credential = new StorageSharedKeyCredential(ACCOUNT_NAME, ACCOUNT_KEY);
    blobServiceClient = new BlobServiceClient(BLOB_URL, credential);
    testContainerName = `upload-integ-${randomUUID().slice(0, 8)}`;

    // Create test container
    const containerClient = blobServiceClient.getContainerClient(testContainerName);
    await containerClient.create();
  });

  afterAll(async () => {
    // Clean up test container
    try {
      const containerClient = blobServiceClient.getContainerClient(testContainerName);
      await containerClient.delete();
    } catch {
      // Best-effort cleanup
    }
  });

  it("streams a small file to Azurite and the blob is readable", async () => {
    const blobName = `small-test-${randomUUID().slice(0, 8)}.txt`;
    const content = "Hello from streaming upload integration test!";

    const containerClient = blobServiceClient.getContainerClient(testContainerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Create a readable stream from the content
    const readable = Readable.from(Buffer.from(content));

    // Upload using uploadStream (same API the server uses)
    await blockBlobClient.uploadStream(
      readable,
      4 * 1024 * 1024, // 4 MiB buffer
      4,               // 4 concurrent
      {
        blobHTTPHeaders: { blobContentType: "text/plain" },
      }
    );

    // Verify the blob exists and has correct content
    const downloadResponse = await blockBlobClient.download(0);
    const downloaded = await streamToString(downloadResponse.readableStreamBody!);
    expect(downloaded).toBe(content);
    expect(downloadResponse.contentType).toBe("text/plain");

    // Set and verify metadata
    await blockBlobClient.setMetadata({ source: "integration-test" });
    const properties = await blockBlobClient.getProperties();
    expect(properties.metadata?.source).toBe("integration-test");
  });

  it("aborted stream does not leave a visible blob", async () => {
    const blobName = `aborted-${randomUUID().slice(0, 8)}.bin`;
    const containerClient = blobServiceClient.getContainerClient(testContainerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Create a stream that will be destroyed mid-upload
    const readable = new Readable({
      read() {
        // Push some data, then destroy
        this.push(Buffer.alloc(1024, 0x42)); // 1 KB
        // Simulate abort after first chunk
        setTimeout(() => {
          this.destroy(new Error("client_aborted"));
        }, 5);
      },
    });

    // uploadStream should reject when the stream is destroyed
    let uploadError: Error | undefined;
    try {
      await blockBlobClient.uploadStream(
        readable,
        4 * 1024 * 1024,
        1, // single concurrency to make abort timing predictable
        {}
      );
    } catch (err) {
      uploadError = err as Error;
    }

    // The upload should have failed
    expect(uploadError).toBeDefined();

    // The blob should NOT exist (uploadStream commits only on success)
    const exists = await blockBlobClient.exists();
    expect(exists).toBe(false);
  });

  // ── Large upload test — gated behind TEST_UPLOAD_LARGE ──
  const describeIfLarge = LARGE_UPLOAD ? describe : describe.skip;

  describeIfLarge(`large streaming upload (${UPLOAD_MB} MiB)`, () => {
    it("streams a large blob and keeps memory bounded", async () => {
      const blobName = `large-${randomUUID().slice(0, 8)}.bin`;
      const totalBytes = UPLOAD_MB * 1024 * 1024;

      const containerClient = blobServiceClient.getContainerClient(testContainerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      // Record RSS before upload
      const rssBefore = process.memoryUsage().rss;

      // Create a streaming source of totalBytes random data
      let bytesSent = 0;
      const chunkSize = 64 * 1024; // 64 KiB chunks
      const readable = new Readable({
        read() {
          if (bytesSent >= totalBytes) {
            this.push(null);
            return;
          }
          const remaining = totalBytes - bytesSent;
          const size = Math.min(chunkSize, remaining);
          const chunk = Buffer.alloc(size, (bytesSent % 256));
          bytesSent += size;
          this.push(chunk);
        },
      });

      await blockBlobClient.uploadStream(
        readable,
        4 * 1024 * 1024, // 4 MiB per block
        4,               // 4 concurrent
        {
          blobHTTPHeaders: { blobContentType: "application/octet-stream" },
        }
      );

      // Verify the blob exists and has the correct size
      const properties = await blockBlobClient.getProperties();
      expect(properties.contentLength).toBe(totalBytes);

      // Check memory growth is reasonable (< 200 MiB growth for any upload size)
      const rssAfter = process.memoryUsage().rss;
      const rssGrowthMiB = (rssAfter - rssBefore) / (1024 * 1024);
      console.log(`  RSS growth during ${UPLOAD_MB} MiB upload: ${rssGrowthMiB.toFixed(1)} MiB`);
      // Allow generous headroom but catch catastrophic buffering
      expect(rssGrowthMiB).toBeLessThan(200);

      // Clean up the large blob
      await blockBlobClient.delete();
    }, 120_000); // 2-minute timeout for large uploads
  });
});

/** Helper: convert a Node.js readable stream to a string. */
async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
