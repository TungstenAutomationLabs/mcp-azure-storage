/**
 * Integration tests for queue tools against Azurite.
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
  QueueServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-queue";
import {
  createTestApp,
  mcpPost,
  toolCallRequest,
  extractToolText,
  extractToolJson,
} from "../helpers/mcp-test-harness.js";
import { registerQueueTools } from "../../src/tools/queue-tools.js";

const SKIP = !process.env.TEST_INTEGRATION;

describe.skipIf(SKIP)("queue-tools integration (Azurite)", () => {
  const queueName = `test-int-${Date.now()}`;
  let app: ReturnType<typeof createTestApp>;
  let queueServiceClient: QueueServiceClient;

  beforeAll(async () => {
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME!;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY!;
    const url = process.env.AZURE_QUEUE_SERVICE_URL!;

    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    queueServiceClient = new QueueServiceClient(url, credential);

    app = createTestApp((server) => registerQueueTools(server));
  });

  afterAll(async () => {
    try {
      const queueClient = queueServiceClient.getQueueClient(queueName);
      await queueClient.deleteIfExists();
    } catch {
      /* best-effort cleanup */
    }
  });

  it("creates a queue via queue-create", async () => {
    const res = await mcpPost(
      app,
      toolCallRequest("queue-create", { queueName })
    ).expect(200);

    const text = extractToolText(res);
    expect(text).toContain(queueName);
    expect(text).toContain("ready");
  });

  it("lists queues including the new one", async () => {
    const res = await mcpPost(
      app,
      toolCallRequest("queue-list")
    ).expect(200);

    const data = extractToolJson(res);
    expect(data).toContain(queueName);
  });

  it("sends and peeks a message", async () => {
    // Send
    const sendRes = await mcpPost(
      app,
      toolCallRequest("queue-send-message", {
        queueName,
        message: "hello from integration test",
      })
    ).expect(200);

    const sendData = extractToolJson(sendRes);
    expect(sendData.success).toBe(true);
    expect(sendData.messageId).toBeDefined();

    // Peek
    const peekRes = await mcpPost(
      app,
      toolCallRequest("queue-peek-messages", { queueName, count: 1 })
    ).expect(200);

    const peekData = extractToolJson(peekRes);
    expect(peekData).toHaveLength(1);
    expect(peekData[0].messageText).toBe("hello from integration test");
  });

  it("receives and deletes a message", async () => {
    const receiveRes = await mcpPost(
      app,
      toolCallRequest("queue-receive-messages", {
        queueName,
        count: 1,
        visibilityTimeoutSeconds: 30,
      })
    ).expect(200);

    const receiveData = extractToolJson(receiveRes);
    expect(receiveData).toHaveLength(1);
    const { messageId, popReceipt } = receiveData[0];

    // Delete
    const deleteRes = await mcpPost(
      app,
      toolCallRequest("queue-delete-message", {
        queueName,
        messageId,
        popReceipt,
      })
    ).expect(200);

    const deleteData = extractToolJson(deleteRes);
    expect(deleteData.success).toBe(true);
  });

  it("deletes the queue", async () => {
    const res = await mcpPost(
      app,
      toolCallRequest("queue-delete", { queueName })
    ).expect(200);

    const text = extractToolText(res);
    expect(text).toContain("deleted");
  });
});
