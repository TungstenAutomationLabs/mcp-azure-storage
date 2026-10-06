/**
 * Azure Queue Storage MCP tools — 8 tools.
 *
 * Provides queue management (create, delete) and message operations
 * (send, peek, receive, delete, update, renew-lease).
 *
 * Note: Queue listing and queue properties are provided by the
 * `azure-queue:///queues` and `azure-queue:///queues/{queueName}/properties`
 * MCP resources (see resources/queue-resources.ts).
 *
 * Queue processing follows the receive → process → delete pattern:
 *  1. `queue-receive-messages` dequeues messages and makes them invisible.
 *  2. The caller processes each message.
 *  3. `queue-delete-message` permanently removes processed messages.
 *  4. If delete is not called within the visibility timeout, the message
 *     reappears in the queue for retry (at-least-once delivery).
 *
 * For long-running tasks, use `queue-update-message` to patch progress
 * fields and optionally renew the lease, or `queue-renew-lease` to extend
 * the visibility timeout without mutating the message body.
 *
 * @module tools/queue-tools
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatSchema, formatResponse } from "../utils/format.js";
import {
  QueueServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-queue";
import { getStorageConfig } from "../config.js";

/** Azure Queue message body limit: 64 KiB. */
const MAX_MESSAGE_BYTES = 65_536;

/**
 * Maximum visibility timeout in seconds.
 * Configurable via MAX_QUEUE_VISIBILITY_SECONDS env var (default: 3600 = 1 hour).
 */
function getMaxVisibilitySeconds(): number {
  const raw = process.env.MAX_QUEUE_VISIBILITY_SECONDS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 3600;
}

/**
 * Create an InvalidArgumentError that flows through the structured error mapper.
 */
function invalidArgError(message: string, field?: string): Error {
  const err = new Error(message) as Error & { name: string; code: string; field?: string };
  err.name = "InvalidArgumentError";
  err.code = "ERR_INVALID_ARG";
  if (field) err.field = field;
  return err;
}

/**
 * Create a TooLargeError that flows through the structured error mapper.
 */
function tooLargeError(message: string, maxBytes: number): Error {
  const err = new Error(message) as Error & { name: string; maxBytes: number };
  err.name = "TooLargeError";
  err.maxBytes = maxBytes;
  return err;
}

/**
 * Register all 8 Queue Storage tools on the given MCP server.
 *
 * Creates a singleton QueueServiceClient that reuses the internal HTTP
 * connection pool across all tool invocations.
 */
export function registerQueueTools(server: McpServer): void {
  const config = getStorageConfig();

  // Singleton client — shared across all queue tool calls for connection reuse.
  const credential = new StorageSharedKeyCredential(
    config.accountName,
    config.accountKey
  );
  const queueServiceUrl =
    config.queueServiceUrl || `https://${config.accountName}.queue.core.windows.net`;
  const queueServiceClient = new QueueServiceClient(queueServiceUrl, credential);

  // ── QUEUE MANAGEMENT ─────────────────────────────────────────────────────

  server.tool(
    "queue-create",
    "Create a new queue if it doesn't already exist. Idempotent — safe to call even if the queue already exists. Use this before sending messages to a new queue.",
    { queueName: z.string().describe("Queue name (lowercase letters, digits, and hyphens, 3-63 chars, e.g. 'order-processing')"), format: formatSchema },
    async ({ queueName, format }) => {
      const client = queueServiceClient;
      const queueClient = client.getQueueClient(queueName);
      await queueClient.createIfNotExists();
      return formatResponse({ status: "ready", queueName }, format, "Queue Created");
    }
  );

  server.tool(
    "queue-delete",
    "Permanently delete a queue and ALL messages in it. WARNING: This is irreversible — all pending messages will be lost. Check the azure-queue:///queues/{queueName}/properties resource for the message count before deleting.",
    { queueName: z.string().describe("Name of the queue to delete (e.g. 'order-processing')"), format: formatSchema },
    async ({ queueName, format }) => {
      const client = queueServiceClient;
      const queueClient = client.getQueueClient(queueName);
      await queueClient.delete();
      return formatResponse({ success: true, deleted: queueName }, format, "Queue Deleted");
    }
  );

  // ── MESSAGE OPERATIONS ───────────────────────────────────────────────────
  // Messages follow the receive → process → delete pattern.
  // peek is a read-only preview; receive hides messages for processing.

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
      format: formatSchema,
    },
    async ({ queueName, message, ttlSeconds, format }) => {
      const client = queueServiceClient;
      const queueClient = client.getQueueClient(queueName);
      const result = await queueClient.sendMessage(message, {
        messageTimeToLive: ttlSeconds,
      });
      return formatResponse({
        success: true,
        messageId: result.messageId,
        expiresOn: result.expiresOn,
      }, format, "Message Sent");
    }
  );

  server.tool(
    "queue-peek-messages",
    "Preview messages at the front of a queue WITHOUT removing or hiding them. Use this to inspect queue contents without affecting processing. Messages remain visible to other receivers. Returns an array of objects with 'messageId', 'messageText', 'insertedOn', 'expiresOn', and 'dequeueCount'.",
    {
      queueName: z.string().describe("Name of the queue to peek into (e.g. 'order-processing')"),
      count: z.number().optional().default(5).describe("Number of messages to peek at (1-32, default: 5)"),
      format: formatSchema,
    },
    async ({ queueName, count, format }) => {
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
      return formatResponse(messages, format, "Peeked Messages");
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
      format: formatSchema,
    },
    async ({ queueName, count, visibilityTimeoutSeconds, format }) => {
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
      return formatResponse(messages, format, "Received Messages");
    }
  );

  server.tool(
    "queue-delete-message",
    "Permanently delete a specific message from a queue after it has been processed. This completes the receive→process→delete workflow. Both 'messageId' and 'popReceipt' are obtained from the 'queue-receive-messages' response. Returns JSON with 'success' and 'deletedMessageId'.",
    {
      queueName: z.string().describe("Name of the queue containing the message (e.g. 'order-processing')"),
      messageId: z.string().describe("Message ID returned by 'queue-receive-messages' (e.g. '2f43b...')"),
      popReceipt: z.string().describe("Pop receipt returned by 'queue-receive-messages' — required to prove this receiver owns the message lock"),
      format: formatSchema,
    },
    async ({ queueName, messageId, popReceipt, format }) => {
      const client = queueServiceClient;
      const queueClient = client.getQueueClient(queueName);
      await queueClient.deleteMessage(messageId, popReceipt);
      return formatResponse({ success: true, deletedMessageId: messageId }, format, "Message Deleted");
    }
  );

  // ── LEASE RENEWAL & MESSAGE UPDATE ─────────────────────────────────────

  server.tool(
    "queue-update-message",
    "Update an existing queue message body with additive fields and optionally renew the message lease (visibility timeout). The message body must be a JSON object — non-JSON messages cannot be patched. Fields are merged additively (existing fields are preserved). Pass the current messageText from queue-receive-messages so existing fields are preserved during the merge. Returns the updated body and new popReceipt.",
    {
      queueName: z.string().describe("Name of the queue containing the message"),
      messageId: z.string().describe("Message ID from queue-receive-messages"),
      popReceipt: z.string().describe("Pop receipt from queue-receive-messages or a previous update"),
      messageText: z.string().optional()
        .describe("Current message body text (from queue-receive-messages). Required to preserve existing fields during additive merge. Must be a JSON object string."),
      patch: z.object({
        state: z.enum(["queued", "running", "completed", "failed", "abandoned"]).optional()
          .describe("Work item state"),
        progress: z.number().optional()
          .describe("Progress percentage (0–100 inclusive, integer)"),
        attempt: z.number().optional()
          .describe("Attempt count (non-negative integer)"),
        owner: z.string().optional()
          .describe("Agent or worker ID that owns this work item"),
        details: z.record(z.string(), z.string()).optional()
          .describe("Additional metadata as string key-value pairs (merged shallowly into existing details)"),
      }).optional().describe("Fields to merge into the message body (additive — does not remove existing fields)"),
      leaseSeconds: z.number().optional()
        .describe("Renew the message lease (visibility timeout) to this many seconds from now. Must be > 0 and <= MAX_QUEUE_VISIBILITY_SECONDS (default 3600)."),
      format: formatSchema,
    },
    async ({ queueName, messageId, popReceipt, messageText, patch, leaseSeconds, format }) => {
      const maxVis = getMaxVisibilitySeconds();

      // ── Validate leaseSeconds ──────────────────────────────────────────
      if (leaseSeconds !== undefined) {
        if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0 || leaseSeconds > maxVis) {
          throw invalidArgError(
            `leaseSeconds must be an integer between 1 and ${maxVis}`,
            "leaseSeconds"
          );
        }
      }

      // ── Validate patch fields ──────────────────────────────────────────
      if (patch) {
        if (patch.progress !== undefined) {
          if (!Number.isInteger(patch.progress) || patch.progress < 0 || patch.progress > 100) {
            throw invalidArgError(
              "progress must be an integer between 0 and 100",
              "progress"
            );
          }
        }
        if (patch.attempt !== undefined) {
          if (!Number.isInteger(patch.attempt) || patch.attempt < 0) {
            throw invalidArgError(
              "attempt must be a non-negative integer",
              "attempt"
            );
          }
        }
      }

      // ── Parse existing body ────────────────────────────────────────────
      let body: Record<string, unknown> = {};
      if (messageText !== undefined) {
        try {
          const parsed = JSON.parse(messageText);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw invalidArgError(
              "messageText must be a JSON object (not array, null, or primitive)",
              "messageText"
            );
          }
          body = parsed;
        } catch (e) {
          if (e instanceof SyntaxError) {
            throw invalidArgError(
              "messageText is not valid JSON — only JSON object messages can be patched",
              "messageText"
            );
          }
          throw e; // re-throw our own invalidArgError
        }
      }

      // ── Apply additive patch ───────────────────────────────────────────
      if (patch) {
        if (patch.state !== undefined) body.state = patch.state;
        if (patch.progress !== undefined) body.progress = patch.progress;
        if (patch.attempt !== undefined) body.attempt = patch.attempt;
        if (patch.owner !== undefined) body.owner = patch.owner;
        if (patch.details !== undefined) {
          const existing = (typeof body.details === "object" && body.details !== null && !Array.isArray(body.details))
            ? body.details as Record<string, string>
            : {};
          body.details = { ...existing, ...patch.details };
        }
      }

      // Server-managed timestamp
      body.updatedAt = new Date().toISOString();

      const bodyString = JSON.stringify(body);

      // ── Enforce 64 KiB body limit ──────────────────────────────────────
      const bodyBytes = Buffer.byteLength(bodyString, "utf-8");
      if (bodyBytes > MAX_MESSAGE_BYTES) {
        throw tooLargeError(
          `Updated message body (${bodyBytes} bytes) exceeds the 64 KiB Azure Queue limit`,
          MAX_MESSAGE_BYTES
        );
      }

      // ── Call Azure updateMessage ───────────────────────────────────────
      const queueClient = queueServiceClient.getQueueClient(queueName);
      const visibilityTimeout = leaseSeconds ?? 0;
      const result = await queueClient.updateMessage(
        messageId,
        popReceipt,
        bodyString,
        visibilityTimeout
      );

      const response: Record<string, unknown> = {
        ok: true,
        messageId,
        popReceipt: result.popReceipt,
        body,
      };
      if (leaseSeconds !== undefined) {
        response.visibilityTimeout = leaseSeconds;
      }

      return formatResponse(response, format, "Message Updated");
    }
  );

  server.tool(
    "queue-renew-lease",
    "Renew an existing message lease (visibility timeout) without modifying the message body. Pass the current messageText from queue-receive-messages to preserve the body content. Returns the new popReceipt (use it for subsequent operations on this message).",
    {
      queueName: z.string().describe("Name of the queue containing the message"),
      messageId: z.string().describe("Message ID from queue-receive-messages"),
      popReceipt: z.string().describe("Pop receipt from queue-receive-messages or a previous update/renewal"),
      leaseSeconds: z.number().describe("New visibility timeout in seconds (must be > 0 and <= MAX_QUEUE_VISIBILITY_SECONDS, default max 3600)"),
      messageText: z.string().optional()
        .describe("Current message body text (from queue-receive-messages). Pass this to preserve the message body during renewal."),
      format: formatSchema,
    },
    async ({ queueName, messageId, popReceipt, leaseSeconds, messageText, format }) => {
      const maxVis = getMaxVisibilitySeconds();

      // ── Validate leaseSeconds ──────────────────────────────────────────
      if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0 || leaseSeconds > maxVis) {
        throw invalidArgError(
          `leaseSeconds must be an integer between 1 and ${maxVis}`,
          "leaseSeconds"
        );
      }

      const queueClient = queueServiceClient.getQueueClient(queueName);

      // Azure updateMessage replaces the body — pass the original text to
      // preserve it, or empty string if not provided.
      const bodyText = messageText ?? "";

      const result = await queueClient.updateMessage(
        messageId,
        popReceipt,
        bodyText,
        leaseSeconds
      );

      return formatResponse({
        ok: true,
        messageId,
        popReceipt: result.popReceipt,
        leaseSeconds,
      }, format, "Lease Renewed");
    }
  );

}
