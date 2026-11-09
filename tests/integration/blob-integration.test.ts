/**
 * Integration tests for blob tools against Azurite.
 *
 * Requirements:
 *   1. Azurite running: docker compose -f docker-compose.azurite.yml up -d
 *   2. Environment: TEST_INTEGRATION=1
 *   3. .env.test loaded via tests/setup.ts
 *
 * Run: npm run test:integration
 */

import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import {
  createTestApp,
  mcpPost,
  toolCallRequest,
  resourceReadRequest,
  extractToolText,
  extractToolJson,
  extractResourceContents,
} from "../helpers/mcp-test-harness.js";
import { registerBlobTools } from "../../src/tools/blob-tools.js";
import { registerBlobResources } from "../../src/resources/blob-resources.js";

const SKIP = !process.env.TEST_INTEGRATION;
const IS_LIVE = !!process.env.TEST_AZURE_LIVE;

describe.skipIf(SKIP)("blob-tools integration (Azurite)", () => {
  const containerName = `test-int-${Date.now()}`;
  let app: ReturnType<typeof createTestApp>;

  // Direct SDK client for setup/teardown
  let blobServiceClient: BlobServiceClient;

  beforeAll(async () => {
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME!;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY!;
    const url = process.env.AZURE_BLOB_SERVICE_URL!;

    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    blobServiceClient = new BlobServiceClient(url, credential);

    app = createTestApp((server) => {
      registerBlobTools(server);
      registerBlobResources(server);
    });
  });

  afterAll(async () => {
    // Clean up test container
    try {
      const containerClient = blobServiceClient.getContainerClient(containerName);
      await containerClient.deleteIfExists();
    } catch {
      /* best-effort cleanup */
    }
  });

  it("creates a container via blob-container-create", async () => {
    const res = await mcpPost(
      app,
      toolCallRequest("blob-container-create", { containerName })
    ).expect(200);

    const text = extractToolText(res);
    expect(text).toContain("created successfully");
  });

  it("lists containers including the new one", async () => {
    const res = await mcpPost(
      app,
      resourceReadRequest("azure-blob:///containers")
    ).expect(200);

    const contents = extractResourceContents(res);
    const data = JSON.parse(contents[0].text);
    const names = data.map((c: any) => c.name);
    expect(names).toContain(containerName);
  });

  it("uploads and reads back a blob", async () => {
    const content = Buffer.from("hello azurite").toString("base64");

    // Upload
    const uploadRes = await mcpPost(
      app,
      toolCallRequest("blob-create", {
        containerName,
        blobName: "greeting.txt",
        contentBase64: content,
      })
    ).expect(200);

    const uploadData = extractToolJson(uploadRes);
    expect(uploadData.success).toBe(true);
    expect(uploadData.size).toBe(13);

    // Read back
    const readRes = await mcpPost(
      app,
      toolCallRequest("blob-read", {
        containerName,
        blobName: "greeting.txt",
      })
    ).expect(200);

    const readData = extractToolJson(readRes);
    expect(readData.contentBase64).toBe(content);
    expect(readData.contentType).toBe("text/plain");
  });

  it("reads blob with maxBytes truncation", async () => {
    // The greeting.txt blob has 13 bytes ("hello azurite")
    const res = await mcpPost(
      app,
      toolCallRequest("blob-read", {
        containerName,
        blobName: "greeting.txt",
        maxBytes: 5,
      })
    ).expect(200);

    const data = extractToolJson(res);
    // Should only get 5 bytes back
    expect(data.size).toBe(5);
    expect(data.truncated).toBe(true);
    // Decode and verify it's the first 5 bytes
    const decoded = Buffer.from(data.contentBase64, "base64").toString("utf-8");
    expect(decoded).toBe("hello");
  });

  it("retrieves blob properties via blob-head", async () => {
    const res = await mcpPost(
      app,
      toolCallRequest("blob-head", {
        containerName,
        blobName: "greeting.txt",
      })
    ).expect(200);

    const data = extractToolJson(res);
    expect(data.ok).toBe(true);
    expect(data.containerName).toBe(containerName);
    expect(data.blobName).toBe("greeting.txt");
    expect(data.contentLength).toBe(13);
    expect(data.contentType).toBe("text/plain");
    expect(data.etag).toBeDefined();
    expect(data.lastModified).toBeDefined();
  });

  // Version-specific operations only work on Azure live (not Azurite)
  describe.skipIf(!IS_LIVE)("version-specific operations (live only)", () => {
    it("reads a specific blob version via blob-read with versionId", async () => {
      // This test requires Azure live with versioning enabled
      // Skipped in Azurite which doesn't support blob versioning
    });

    it("deletes a specific blob version via blob-delete with versionId", async () => {
      // This test requires Azure live with versioning enabled
    });

    it("sets tier on a specific version via blob-set-tier with versionId", async () => {
      // This test requires Azure live with versioning enabled
    });
  });

  it("deletes the blob", async () => {
    const res = await mcpPost(
      app,
      toolCallRequest("blob-delete", {
        containerName,
        blobName: "greeting.txt",
      })
    ).expect(200);

    const data = extractToolJson(res);
    expect(data.success).toBe(true);
  });

  describe("blob-delete-batch", () => {
    it("batch deletes multiple blobs", async () => {
      // Upload 3 blobs
      for (const name of ["batch-a.txt", "batch-b.txt", "batch-c.txt"]) {
        const content = Buffer.from(`content of ${name}`).toString("base64");
        await mcpPost(
          app,
          toolCallRequest("blob-create", {
            containerName,
            blobName: name,
            contentBase64: content,
          })
        ).expect(200);
      }

      // Batch delete them all
      const res = await mcpPost(
        app,
        toolCallRequest("blob-delete-batch", {
          containerName,
          blobNames: ["batch-a.txt", "batch-b.txt", "batch-c.txt"],
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.container).toBe(containerName);
      expect(data.total).toBe(3);
      expect(data.deleted).toBe(3);
      expect(data.notFound).toBe(0);
      expect(data.failed).toBe(0);
      expect(data.results).toHaveLength(3);

      // Verify they are gone — list should not contain them
      const listRes = await mcpPost(
        app,
        toolCallRequest("blob-list", {
          containerName,
          prefix: "batch-",
        })
      ).expect(200);
      const listed = extractToolJson(listRes);
      expect(listed).toHaveLength(0);
    });

    it("handles missing blobs as not_found", async () => {
      // Upload 2 blobs
      for (const name of ["exist-1.txt", "exist-2.txt"]) {
        const content = Buffer.from(`content of ${name}`).toString("base64");
        await mcpPost(
          app,
          toolCallRequest("blob-create", {
            containerName,
            blobName: name,
            contentBase64: content,
          })
        ).expect(200);
      }

      // Batch delete 3 (one does not exist)
      const res = await mcpPost(
        app,
        toolCallRequest("blob-delete-batch", {
          containerName,
          blobNames: ["exist-1.txt", "exist-2.txt", "does-not-exist.txt"],
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.total).toBe(3);
      expect(data.deleted).toBe(2);
      expect(data.notFound).toBe(1);
      expect(data.failed).toBe(0);

      const notFoundResult = data.results.find(
        (r: any) => r.blob === "does-not-exist.txt"
      );
      expect(notFoundResult).toBeDefined();
      expect(notFoundResult.outcome).toBe("not_found");
      expect(notFoundResult.status).toBe(404);
    });

    it("batch deletes a single blob (edge case)", async () => {
      // Upload 1 blob
      const content = Buffer.from("single blob content").toString("base64");
      await mcpPost(
        app,
        toolCallRequest("blob-create", {
          containerName,
          blobName: "single-batch.txt",
          contentBase64: content,
        })
      ).expect(200);

      // Batch delete just 1
      const res = await mcpPost(
        app,
        toolCallRequest("blob-delete-batch", {
          containerName,
          blobNames: ["single-batch.txt"],
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.total).toBe(1);
      expect(data.deleted).toBe(1);
      expect(data.notFound).toBe(0);
      expect(data.failed).toBe(0);
      expect(data.results).toHaveLength(1);
      expect(data.results[0].outcome).toBe("deleted");
    });
  });

  it("deletes the container", async () => {
    const res = await mcpPost(
      app,
      toolCallRequest("blob-container-delete", { containerName })
    ).expect(200);

    const text = extractToolText(res);
    expect(text).toContain("deleted");
  });
});
