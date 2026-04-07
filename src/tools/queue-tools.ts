import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  QueueServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-queue";
import { getStorageConfig } from "../config.js";

export function registerQueueTools(server: McpServer): void {
  const config = getStorageConfig();

  // ── Singleton client — reuses internal connection pool across all tool calls ──
  const credential = new StorageSharedKeyCredential(
    config.accountName,
    config.accountKey
  );
  const queueServiceClient = new QueueServiceClient(
    `https://${config.accountName}.queue.core.windows.net`,
    credential
  );

  // ── QUEUE MANAGEMENT ──

  server.tool("queue-list", "List all queues in the storage account. Use this to discover available queues before sending or receiving messages. Returns a JSON array of queue name strings.", {}, async () => {
    const client = queueServiceClient;
    const queues: string[] = [];
    for await (const queue of client.listQueues()) {
      queues.push(queue.name);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(queues, null, 2) }],
    };
  });

  server.tool(
    "queue-create",
    "Create a new queue if it doesn't already exist. Idempotent — safe to call even if the queue already exists. Use this before sending messages to a new queue.",
    { queueName: z.string().describe("Queue name (lowercase letters, digits, and hyphens, 3-63 chars, e.g. 'order-processing')") },
    async ({ queueName }) => {
      const client = queueServiceClient;
      const queueClient = client.getQueueClient(queueName);
      await queueClient.createIfNotExists();
      return {
        content: [{ type: "text", text: `Queue "${queueName}" ready.` }],
      };
    }
  );

  server.tool(
    "queue-delete",
    "Permanently delete a queue and ALL messages in it. WARNING: This is irreversible — all pending messages will be lost. Use 'queue-get-properties' to check the message count before deleting.",
    { queueName: z.string().describe("Name of the queue to delete (e.g. 'order-processing')") },
    async ({ queueName }) => {
      const client = queueServiceClient;
      const queueClient = client.getQueueClient(queueName);
      await queueClient.delete();
      return {
        content: [{ type: "text", text: `Deleted queue "${queueName}".` }],
      };
    }
  );

  // ── MESSAGE OPERATIONS ──

  server.tool(
    "queue-send-message",
    "Send a text message to a queue for asynchronous processing. The message becomes visible to receivers immediately. Returns JSON with 'messageId' and 'expiresOn'. For structured data, serialise to JSON string before sending.",
    {
      queueName: z.string().describe("Name of the target queue (e.g. 'order-processing')"),
      message: z.string().describe("Message body as a text string (max 64 KB). For structured data, serialise as JSON string first."),
      ttlSeconds: z
        .number()
        .optional()
        .default(-1)
        .describe("Time-to-live in seconds before the message auto-expires. Use -1 for no expiry (default), or a positive value like 3600 for 1 hour."),
    },
    async ({ queueName, message, ttlSeconds }) => {
      const client = queueServiceClient;
      const queueClient = client.getQueueClient(queueName);
      const result = await queueClient.sendMessage(message, {
        messageTimeToLive: ttlSeconds,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              messageId: result.messageId,
              expiresOn: result.expiresOn,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "queue-peek-messages",
    "Preview messages at the front of a queue WITHOUT removing or hiding them. Use this to inspect queue contents without affecting processing. Messages remain visible to other receivers. Returns an array of objects with 'messageId', 'messageText', 'insertedOn', 'expiresOn', and 'dequeueCount'.",
    {
      queueName: z.string().describe("Name of the queue to peek into (e.g. 'order-processing')"),
      count: z.number().optional().default(5).describe("Number of messages to peek at (1-32, default: 5)"),
    },
    async ({ queueName, count }) => {
      const client = queueServiceClient;
      const queueClient = client.getQueueClient(queueName);
      const response = await queueClient.peekMessages({ numberOfMessages: Math.min(count, 32) });
      const messages = response.peekedMessageItems.map((m) => ({
        messageId: m.messageId,
        messageText: m.messageText,
        insertedOn: m.insertedOn,
        expiresOn: m.expiresOn,
        dequeueCount: m.dequeueCount,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
      };
    }
  );

  server.tool(
    "queue-receive-messages",
    "Receive messages from a queue for processing. Received messages become invisible to other receivers for the visibility timeout period. IMPORTANT: After processing each message, call 'queue-delete-message' with the returned 'messageId' and 'popReceipt' to permanently remove it. If not deleted within the visibility timeout, the message reappears in the queue for retry. Returns an array of objects with 'messageId', 'popReceipt', 'messageText', and 'dequeueCount'.",
    {
      queueName: z.string().describe("Name of the queue to receive from (e.g. 'order-processing')"),
      count: z.number().optional().default(1).describe("Number of messages to receive (1-32, default: 1)"),
      visibilityTimeoutSeconds: z
        .number()
        .optional()
        .default(30)
        .describe("Seconds the message stays hidden from other receivers while you process it (default: 30). Set higher for long-running tasks."),
    },
    async ({ queueName, count, visibilityTimeoutSeconds }) => {
      const client = queueServiceClient;
      const queueClient = client.getQueueClient(queueName);
      const response = await queueClient.receiveMessages({
        numberOfMessages: Math.min(count, 32),
        visibilityTimeout: visibilityTimeoutSeconds,
      });
      const messages = response.receivedMessageItems.map((m) => ({
        messageId: m.messageId,
        popReceipt: m.popReceipt,
        messageText: m.messageText,
        dequeueCount: m.dequeueCount,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
      };
    }
  );

  server.tool(
    "queue-delete-message",
    "Permanently delete a specific message from a queue after it has been processed. This completes the receive→process→delete workflow. Both 'messageId' and 'popReceipt' are obtained from the 'queue-receive-messages' response. Returns JSON with 'success' and 'deletedMessageId'.",
    {
      queueName: z.string().describe("Name of the queue containing the message (e.g. 'order-processing')"),
      messageId: z.string().describe("Message ID returned by 'queue-receive-messages' (e.g. '2f43b...')"),
      popReceipt: z.string().describe("Pop receipt returned by 'queue-receive-messages' — required to prove this receiver owns the message lock"),
    },
    async ({ queueName, messageId, popReceipt }) => {
      const client = queueServiceClient;
      const queueClient = client.getQueueClient(queueName);
      await queueClient.deleteMessage(messageId, popReceipt);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, deletedMessageId: messageId }),
          },
        ],
      };
    }
  );

  server.tool(
    "queue-get-properties",
    "Get properties for a queue, including the approximate number of pending messages. Use this to check queue depth before processing or to monitor backlog. Returns JSON with 'queueName' and 'approximateMessagesCount'. Note: the count is approximate due to Azure's distributed architecture.",
    { queueName: z.string().describe("Name of the queue to inspect (e.g. 'order-processing')") },
    async ({ queueName }) => {
      const client = queueServiceClient;
      const queueClient = client.getQueueClient(queueName);
      const props = await queueClient.getProperties();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              queueName,
              approximateMessagesCount: props.approximateMessagesCount,
            }),
          },
        ],
      };
    }
  );
}
