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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import {
  createTestApp,
  mcpPost,
  toolCallRequest,
  extractToolText,
  extractToolJson,
} from "../helpers/mcp-test-harness.js";
import { registerBlobTools } from "../../src/tools/blob-tools.js";

const SKIP = !process.env.TEST_INTEGRATION;

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

    app = createTestApp((server) => registerBlobTools(server));
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
      toolCallRequest("blob-container-list")
    ).expect(200);

    const data = extractToolJson(res);
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

  it("deletes the container", async () => {
    const res = await mcpPost(
      app,
      toolCallRequest("blob-container-delete", { containerName })
    ).expect(200);

    const text = extractToolText(res);
    expect(text).toContain("deleted");
  });
});
