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

import {
  QueueServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-queue";
import {
  createTestApp,
  mcpPost,
  toolCallRequest,
  resourceReadRequest,
  extractToolText,
  extractToolJson,
  extractResourceContents,
} from "../helpers/mcp-test-harness.js";
import { registerQueueTools } from "../../src/tools/queue-tools.js";
import { registerQueueResources } from "../../src/resources/queue-resources.js";

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

    app = createTestApp((server) => {
      registerQueueTools(server);
      registerQueueResources(server);
    });
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
      resourceReadRequest("azure-queue:///queues")
    ).expect(200);

    const contents = extractResourceContents(res);
    const data = JSON.parse(contents[0].text);
    const names = data.map((q: any) => q.name);
    expect(names).toContain(queueName);
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

  // ── queue-update-message integration ──────────────────────────────────

  describe("queue-update-message + queue-renew-lease", () => {
    const leaseQueueName = `test-lease-${Date.now()}`;

    beforeAll(async () => {
      // Create a fresh queue for lease tests
      await mcpPost(
        app,
        toolCallRequest("queue-create", { queueName: leaseQueueName })
      ).expect(200);
    });

    afterAll(async () => {
      try {
        const queueClient = queueServiceClient.getQueueClient(leaseQueueName);
        await queueClient.deleteIfExists();
      } catch {
        /* best-effort cleanup */
      }
    });

    it("sends JSON message, receives it, updates with patch + lease, then verifies content", async () => {
      // 1. Send a JSON message
      const originalBody = JSON.stringify({
        task: "process-document",
        documentId: "doc-42",
        createdAt: "2024-01-01T00:00:00Z",
      });

      const sendRes = await mcpPost(
        app,
        toolCallRequest("queue-send-message", {
          queueName: leaseQueueName,
          message: originalBody,
        })
      ).expect(200);
      const sendData = extractToolJson(sendRes);
      expect(sendData.success).toBe(true);

      // 2. Receive message to get messageId + popReceipt
      const receiveRes = await mcpPost(
        app,
        toolCallRequest("queue-receive-messages", {
          queueName: leaseQueueName,
          count: 1,
          visibilityTimeoutSeconds: 30,
        })
      ).expect(200);
      const receiveData = extractToolJson(receiveRes);
      expect(receiveData).toHaveLength(1);
      const { messageId, popReceipt, messageText } = receiveData[0];

      // 3. Update message with patch + lease renewal (short: 3 seconds for CI)
      const updateRes = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: leaseQueueName,
          messageId,
          popReceipt,
          messageText,
          patch: {
            state: "running",
            progress: 10,
            attempt: 1,
            owner: "integration-test-worker",
          },
          leaseSeconds: 3,
        })
      ).expect(200);

      const updateData = extractToolJson(updateRes);
      expect(updateData.ok).toBe(true);
      expect(updateData.messageId).toBe(messageId);
      expect(updateData.popReceipt).toBeDefined();
      expect(updateData.popReceipt).not.toBe(popReceipt); // New pop receipt after update
      expect(updateData.visibilityTimeout).toBe(3);

      // Verify body content was merged additively
      expect(updateData.body.task).toBe("process-document");
      expect(updateData.body.documentId).toBe("doc-42");
      expect(updateData.body.createdAt).toBe("2024-01-01T00:00:00Z");
      expect(updateData.body.state).toBe("running");
      expect(updateData.body.progress).toBe(10);
      expect(updateData.body.attempt).toBe(1);
      expect(updateData.body.owner).toBe("integration-test-worker");
      expect(updateData.body.updatedAt).toBeDefined();

      // 4. Wait for the 3-second lease to expire, then receive again to verify content
      await sleep(4000);

      const reReceiveRes = await mcpPost(
        app,
        toolCallRequest("queue-receive-messages", {
          queueName: leaseQueueName,
          count: 1,
          visibilityTimeoutSeconds: 30,
        })
      ).expect(200);

      const reReceiveData = extractToolJson(reReceiveRes);
      expect(reReceiveData).toHaveLength(1);

      const updatedBody = JSON.parse(reReceiveData[0].messageText);
      expect(updatedBody.task).toBe("process-document");
      expect(updatedBody.state).toBe("running");
      expect(updatedBody.progress).toBe(10);
      expect(updatedBody.attempt).toBe(1);
      expect(updatedBody.owner).toBe("integration-test-worker");

      // 5. Renew lease with queue-renew-lease
      const renewRes = await mcpPost(
        app,
        toolCallRequest("queue-renew-lease", {
          queueName: leaseQueueName,
          messageId: reReceiveData[0].messageId,
          popReceipt: reReceiveData[0].popReceipt,
          leaseSeconds: 3,
          messageText: reReceiveData[0].messageText,
        })
      ).expect(200);

      const renewData = extractToolJson(renewRes);
      expect(renewData.ok).toBe(true);
      expect(renewData.popReceipt).toBeDefined();
      expect(renewData.leaseSeconds).toBe(3);

      // 6. Verify message is invisible during lease (peek should not find it,
      //    and receive should return empty)
      const peekDuringLease = await mcpPost(
        app,
        toolCallRequest("queue-peek-messages", {
          queueName: leaseQueueName,
          count: 1,
        })
      ).expect(200);

      const peekedDuring = extractToolJson(peekDuringLease);
      expect(peekedDuring).toHaveLength(0);

      // 7. Wait for lease to expire and verify message reappears
      await sleep(4000);

      const finalReceive = await mcpPost(
        app,
        toolCallRequest("queue-receive-messages", {
          queueName: leaseQueueName,
          count: 1,
          visibilityTimeoutSeconds: 5,
        })
      ).expect(200);

      const finalData = extractToolJson(finalReceive);
      expect(finalData).toHaveLength(1);

      // Body should still contain the preserved content from queue-renew-lease
      const finalBody = JSON.parse(finalData[0].messageText);
      expect(finalBody.task).toBe("process-document");
      expect(finalBody.state).toBe("running");

      // Clean up: delete the message
      await mcpPost(
        app,
        toolCallRequest("queue-delete-message", {
          queueName: leaseQueueName,
          messageId: finalData[0].messageId,
          popReceipt: finalData[0].popReceipt,
        })
      ).expect(200);
    }, 30_000); // 30s timeout for timing-sensitive test
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

/** Sleep helper for timing-sensitive tests. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
