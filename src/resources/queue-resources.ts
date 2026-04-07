/**
 * @module queue-resources
 *
 * MCP Resource definitions for Azure Queue Storage read-only operations.
 *
 * Exposes 2 resources:
 *   - `azure-queue:///queues`                     — list all queues
 *   - `azure-queue:///queues/{queueName}/properties` — queue metadata & message counts
 *
 * Note: Queue *messages* are not exposed as resources because receiving
 * messages has side effects (visibility timeout), and peeking returns
 * transient state that doesn't map well to cacheable resources.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QueueServiceClient, StorageSharedKeyCredential } from "@azure/storage-queue";
import { getStorageConfig } from "../config.js";

// ── Singleton Queue Service Client ─────────────────────────────
const config = getStorageConfig();
const credential = new StorageSharedKeyCredential(config.accountName, config.accountKey);
const queueServiceClient = new QueueServiceClient(
  `https://${config.accountName}.queue.core.windows.net`,
  credential
);

/** Maximum number of items returned by listing resources to prevent oversized responses. */
const MAX_LIST_ITEMS = 500;

/**
 * Registers all Queue Storage MCP resources on the given server instance.
 *
 * @param server - The McpServer to register resources on.
 */
export function registerQueueResources(server: McpServer): void {
  // ── 1. List Queues (static resource) ───────────────────────
  server.resource(
    "queue-list",
    "azure-queue:///queues",
    {
      description: "List all queues in the storage account. Use this to discover which queues exist before sending or processing messages via the queue tools. Returns a JSON array of objects with 'name' (queue name) and 'index' (1-based position). Note: queue messages are accessed via tools (not resources) because receiving has side effects.",
      mimeType: "application/json",
    },
    async (uri) => {
      const queues: { name: string; index: number }[] = [];
      let index = 1;
      for await (const queue of queueServiceClient.listQueues()) {
        queues.push({ name: queue.name, index: index++ });
        if (index > MAX_LIST_ITEMS) break;
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(queues, null, 2),
          },
        ],
      };
    }
  );

  // ── 2. Queue Properties (template resource) ────────────────
  server.resource(
    "queue-properties",
    new ResourceTemplate("azure-queue:///queues/{queueName}/properties", {
      list: undefined, // Discover queue names via the azure-queue:///queues static resource
    }),
    {
      description: "Get properties for a specific queue, including approximate message count and metadata. Use this to check queue depth before deciding whether to receive messages, or to inspect custom metadata. Returns a JSON object with 'name', 'approximateMessagesCount' (may lag by a few seconds), and 'metadata' (key-value pairs). The count is approximate — use queue-peek-messages or queue-receive-messages tools for exact message inspection.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const queueName = String(variables.queueName);
      const queueClient = queueServiceClient.getQueueClient(queueName);
      const properties = await queueClient.getProperties();
      const result = {
        name: queueName,
        approximateMessagesCount: properties.approximateMessagesCount,
        metadata: properties.metadata,
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
