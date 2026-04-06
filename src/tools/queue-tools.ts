import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  QueueServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-queue";
import { getStorageConfig } from "../config.js";

export function registerQueueTools(server: McpServer): void {
  const config = getStorageConfig();

  function getQueueServiceClient(): QueueServiceClient {
    const credential = new StorageSharedKeyCredential(
      config.accountName,
      config.accountKey
    );
    return new QueueServiceClient(
      `https://${config.accountName}.queue.core.windows.net`,
      credential
    );
  }

  // ── QUEUE MANAGEMENT ──

  server.tool("queue-list", "List all queues in the storage account", {}, async () => {
    const client = getQueueServiceClient();
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
    "Create a queue if it doesn't exist",
    { queueName: z.string().describe("Queue name") },
    async ({ queueName }) => {
      const client = getQueueServiceClient();
      const queueClient = client.getQueueClient(queueName);
      await queueClient.createIfNotExists();
      return {
        content: [{ type: "text", text: `Queue "${queueName}" ready.` }],
      };
    }
  );

  server.tool(
    "queue-delete",
    "Delete a queue",
    { queueName: z.string().describe("Queue name") },
    async ({ queueName }) => {
      const client = getQueueServiceClient();
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
    "Send a message to a queue",
    {
      queueName: z.string().describe("Queue name"),
      message: z.string().describe("Message text"),
      ttlSeconds: z
        .number()
        .optional()
        .default(-1)
        .describe("Time-to-live in seconds (-1 = never expires)"),
    },
    async ({ queueName, message, ttlSeconds }) => {
      const client = getQueueServiceClient();
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
    "Peek at messages without removing them",
    {
      queueName: z.string().describe("Queue name"),
      count: z.number().optional().default(5).describe("Number of messages to peek (max 32)"),
    },
    async ({ queueName, count }) => {
      const client = getQueueServiceClient();
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
    "Receive and dequeue messages (removes them from the queue)",
    {
      queueName: z.string().describe("Queue name"),
      count: z.number().optional().default(1).describe("Number of messages (max 32)"),
      visibilityTimeoutSeconds: z
        .number()
        .optional()
        .default(30)
        .describe("Seconds before message becomes visible again if not deleted"),
    },
    async ({ queueName, count, visibilityTimeoutSeconds }) => {
      const client = getQueueServiceClient();
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
    "Delete a specific message from a queue (after receiving it)",
    {
      queueName: z.string().describe("Queue name"),
      messageId: z.string().describe("Message ID from receive"),
      popReceipt: z.string().describe("Pop receipt from receive"),
    },
    async ({ queueName, messageId, popReceipt }) => {
      const client = getQueueServiceClient();
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
    "Get queue properties including approximate message count",
    { queueName: z.string().describe("Queue name") },
    async ({ queueName }) => {
      const client = getQueueServiceClient();
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
