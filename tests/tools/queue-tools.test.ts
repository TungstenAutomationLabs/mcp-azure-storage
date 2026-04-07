/**
 * Unit tests for src/tools/queue-tools.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Azure Storage Queue SDK ─────────────────────────────────────────
const mockListQueues = vi.fn();
const mockCreateIfNotExists = vi.fn();
const mockQueueDelete = vi.fn();
const mockSendMessage = vi.fn();
const mockPeekMessages = vi.fn();
const mockReceiveMessages = vi.fn();
const mockDeleteMessage = vi.fn();
const mockGetProperties = vi.fn();

vi.mock("@azure/storage-queue", () => {
  return {
    StorageSharedKeyCredential: vi.fn().mockImplementation(() => ({})),
    QueueServiceClient: vi.fn().mockImplementation(() => ({
      listQueues: mockListQueues,
      getQueueClient: vi.fn().mockImplementation(() => ({
        createIfNotExists: mockCreateIfNotExists,
        delete: mockQueueDelete,
        sendMessage: mockSendMessage,
        peekMessages: mockPeekMessages,
        receiveMessages: mockReceiveMessages,
        deleteMessage: mockDeleteMessage,
        getProperties: mockGetProperties,
      })),
    })),
  };
});

import {
  createTestApp,
  mcpPost,
  toolCallRequest,
  toolListRequest,
  extractToolText,
  extractToolJson,
  extractToolsList,
} from "../helpers/mcp-test-harness.js";
import { registerQueueTools } from "../../src/tools/queue-tools.js";

function createQueueTestApp() {
  return createTestApp((server) => registerQueueTools(server));
}

describe("queue-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tool registration", () => {
    it("registers 6 queue tools", async () => {
      const app = createQueueTestApp();
      const res = await mcpPost(app, toolListRequest()).expect(200);

      const tools = extractToolsList(res);
      expect(tools).toHaveLength(6);
    });
  });

  // queue-list removed — use azure-queue:///queues resource instead

  describe("queue-create", () => {
    it("creates queue idempotently", async () => {
      mockCreateIfNotExists.mockResolvedValue({});

      const app = createQueueTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("queue-create", { queueName: "new-queue" })
      ).expect(200);

      const text = extractToolText(res);
      expect(text).toContain("new-queue");
      expect(text).toContain("ready");
      expect(mockCreateIfNotExists).toHaveBeenCalled();
    });
  });

  describe("queue-send-message", () => {
    it("sends message with default TTL", async () => {
      const now = new Date();
      mockSendMessage.mockResolvedValue({
        messageId: "msg-123",
        expiresOn: now,
      });

      const app = createQueueTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("queue-send-message", {
          queueName: "test-queue",
          message: "hello",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.success).toBe(true);
      expect(data.messageId).toBe("msg-123");
      expect(mockSendMessage).toHaveBeenCalledWith("hello", {
        messageTimeToLive: -1,
      });
    });

    it("sends message with custom TTL", async () => {
      mockSendMessage.mockResolvedValue({
        messageId: "msg-456",
        expiresOn: new Date(),
      });

      const app = createQueueTestApp();
      await mcpPost(
        app,
        toolCallRequest("queue-send-message", {
          queueName: "test-queue",
          message: "hello",
          ttlSeconds: 3600,
        })
      ).expect(200);

      expect(mockSendMessage).toHaveBeenCalledWith("hello", {
        messageTimeToLive: 3600,
      });
    });
  });

  describe("queue-peek-messages", () => {
    it("returns peeked messages without affecting visibility", async () => {
      mockPeekMessages.mockResolvedValue({
        peekedMessageItems: [
          {
            messageId: "msg-1",
            messageText: "hello",
            insertedOn: new Date("2024-01-01"),
            expiresOn: new Date("2024-01-02"),
            dequeueCount: 0,
          },
        ],
      });

      const app = createQueueTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("queue-peek-messages", { queueName: "test-queue" })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data).toHaveLength(1);
      expect(data[0].messageId).toBe("msg-1");
      expect(data[0].messageText).toBe("hello");
      expect(data[0].dequeueCount).toBe(0);
    });
  });

  describe("queue-receive-messages", () => {
    it("returns received messages with popReceipt", async () => {
      mockReceiveMessages.mockResolvedValue({
        receivedMessageItems: [
          {
            messageId: "msg-1",
            popReceipt: "pop-abc",
            messageText: "process me",
            dequeueCount: 1,
          },
        ],
      });

      const app = createQueueTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("queue-receive-messages", {
          queueName: "test-queue",
          count: 1,
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data).toHaveLength(1);
      expect(data[0].messageId).toBe("msg-1");
      expect(data[0].popReceipt).toBe("pop-abc");
      expect(data[0].messageText).toBe("process me");
    });
  });

  describe("queue-delete-message", () => {
    it("deletes message with id and popReceipt", async () => {
      mockDeleteMessage.mockResolvedValue({});

      const app = createQueueTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("queue-delete-message", {
          queueName: "test-queue",
          messageId: "msg-1",
          popReceipt: "pop-abc",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.success).toBe(true);
      expect(data.deletedMessageId).toBe("msg-1");
      expect(mockDeleteMessage).toHaveBeenCalledWith("msg-1", "pop-abc");
    });
  });

  // queue-get-properties removed — use azure-queue:///queues/{queueName}/properties resource instead
});
