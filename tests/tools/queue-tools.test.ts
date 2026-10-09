/**
 * Unit tests for src/tools/queue-tools.ts
 */


// ── Mock Azure Storage Queue SDK ─────────────────────────────────────────
const mockListQueues = vi.fn();
const mockCreateIfNotExists = vi.fn();
const mockQueueDelete = vi.fn();
const mockSendMessage = vi.fn();
const mockPeekMessages = vi.fn();
const mockReceiveMessages = vi.fn();
const mockDeleteMessage = vi.fn();
const mockGetProperties = vi.fn();
const mockUpdateMessage = vi.fn();

vi.mock("@azure/storage-queue", () => {
  return {
    StorageSharedKeyCredential: vi.fn().mockImplementation(function() { return {}; }),
    QueueServiceClient: vi.fn().mockImplementation(function() { return {
      listQueues: mockListQueues,
      getQueueClient: vi.fn().mockImplementation(function() { return {
        createIfNotExists: mockCreateIfNotExists,
        delete: mockQueueDelete,
        sendMessage: mockSendMessage,
        peekMessages: mockPeekMessages,
        receiveMessages: mockReceiveMessages,
        deleteMessage: mockDeleteMessage,
        getProperties: mockGetProperties,
        updateMessage: mockUpdateMessage,
      }; }),
    }; }),
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
import { wrapToolErrorHandler } from "../../src/utils/errors.js";

function createQueueTestApp() {
  return createTestApp((server) => registerQueueTools(server));
}

/** Create a test app WITH structured error wrapping for validation tests. */
function createQueueTestAppWithErrors() {
  return createTestApp((server) => {
    wrapToolErrorHandler(server);
    registerQueueTools(server);
  });
}

describe("queue-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env var between tests
    delete process.env.MAX_QUEUE_VISIBILITY_SECONDS;
  });

  describe("tool registration", () => {
    it("registers 8 queue tools", async () => {
      const app = createQueueTestApp();
      const res = await mcpPost(app, toolListRequest()).expect(200);

      const tools = extractToolsList(res);
      expect(tools).toHaveLength(8);

      const names = tools.map((t: any) => t.name);
      expect(names).toContain("queue-update-message");
      expect(names).toContain("queue-renew-lease");
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

  // ── queue-update-message ──────────────────────────────────────────────

  describe("queue-update-message", () => {
    it("patches state, progress, attempt, owner, and details", async () => {
      mockUpdateMessage.mockResolvedValue({ popReceipt: "pop-new-1" });

      const app = createQueueTestApp();
      const existingBody = JSON.stringify({ task: "process-image", createdAt: "2024-01-01T00:00:00Z" });
      const res = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "work-queue",
          messageId: "msg-100",
          popReceipt: "pop-old",
          messageText: existingBody,
          patch: {
            state: "running",
            progress: 25,
            attempt: 1,
            owner: "worker-42",
            details: { step: "resize", outputPath: "/tmp/out.png" },
          },
          leaseSeconds: 60,
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.ok).toBe(true);
      expect(data.messageId).toBe("msg-100");
      expect(data.popReceipt).toBe("pop-new-1");
      expect(data.visibilityTimeout).toBe(60);

      // Verify body was merged additively
      expect(data.body.task).toBe("process-image");
      expect(data.body.createdAt).toBe("2024-01-01T00:00:00Z");
      expect(data.body.state).toBe("running");
      expect(data.body.progress).toBe(25);
      expect(data.body.attempt).toBe(1);
      expect(data.body.owner).toBe("worker-42");
      expect(data.body.details.step).toBe("resize");
      expect(data.body.details.outputPath).toBe("/tmp/out.png");
      expect(data.body.updatedAt).toBeDefined();

      // Verify Azure SDK call
      expect(mockUpdateMessage).toHaveBeenCalledWith(
        "msg-100",
        "pop-old",
        expect.any(String),
        60
      );
    });

    it("merges details shallowly with existing details", async () => {
      mockUpdateMessage.mockResolvedValue({ popReceipt: "pop-merged" });

      const app = createQueueTestApp();
      const existingBody = JSON.stringify({
        state: "queued",
        details: { source: "api", priority: "high" },
      });
      const res = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "work-queue",
          messageId: "msg-200",
          popReceipt: "pop-x",
          messageText: existingBody,
          patch: {
            details: { priority: "low", region: "us-east" },
          },
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.body.details.source).toBe("api");       // preserved
      expect(data.body.details.priority).toBe("low");      // overwritten
      expect(data.body.details.region).toBe("us-east");    // new
    });

    it("returns new popReceipt from Azure", async () => {
      mockUpdateMessage.mockResolvedValue({ popReceipt: "pop-refreshed" });

      const app = createQueueTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-old",
          patch: { state: "completed", progress: 100 },
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.popReceipt).toBe("pop-refreshed");
    });

    it("uses visibilityTimeout=0 when leaseSeconds not provided", async () => {
      mockUpdateMessage.mockResolvedValue({ popReceipt: "pop-0" });

      const app = createQueueTestApp();
      await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-old",
          patch: { state: "running" },
        })
      ).expect(200);

      // Fourth arg should be 0 (no lease renewal)
      expect(mockUpdateMessage).toHaveBeenCalledWith(
        "m1", "pop-old", expect.any(String), 0
      );
    });

    it("rejects non-JSON messageText with structured invalid error", async () => {
      const app = createQueueTestAppWithErrors();
      const res = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-x",
          messageText: "not json at all",
          patch: { state: "running" },
        })
      ).expect(200);

      const text = extractToolText(res);
      const parsed = JSON.parse(text);
      expect(parsed.error.code).toBe("invalid");
      expect(parsed.error.field).toBe("messageText");
      expect(parsed.error.retryable).toBe(false);
    });

    it("rejects JSON array messageText with structured invalid error", async () => {
      const app = createQueueTestAppWithErrors();
      const res = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-x",
          messageText: "[1,2,3]",
          patch: { state: "running" },
        })
      ).expect(200);

      const text = extractToolText(res);
      const parsed = JSON.parse(text);
      expect(parsed.error.code).toBe("invalid");
      expect(parsed.error.field).toBe("messageText");
    });

    it("validates progress must be 0..100 integer", async () => {
      const app = createQueueTestAppWithErrors();

      // progress = 101 (out of range)
      const res1 = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-x",
          patch: { progress: 101 },
        })
      ).expect(200);

      const parsed1 = JSON.parse(extractToolText(res1));
      expect(parsed1.error.code).toBe("invalid");
      expect(parsed1.error.field).toBe("progress");

      // progress = -1 (negative)
      const res2 = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "q",
          messageId: "m2",
          popReceipt: "pop-y",
          patch: { progress: -1 },
        })
      ).expect(200);

      const parsed2 = JSON.parse(extractToolText(res2));
      expect(parsed2.error.code).toBe("invalid");
      expect(parsed2.error.field).toBe("progress");

      // progress = 50.5 (not integer)
      const res3 = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "q",
          messageId: "m3",
          popReceipt: "pop-z",
          patch: { progress: 50.5 },
        })
      ).expect(200);

      const parsed3 = JSON.parse(extractToolText(res3));
      expect(parsed3.error.code).toBe("invalid");
      expect(parsed3.error.field).toBe("progress");
    });

    it("validates attempt must be non-negative integer", async () => {
      const app = createQueueTestAppWithErrors();

      const res = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-x",
          patch: { attempt: -1 },
        })
      ).expect(200);

      const parsed = JSON.parse(extractToolText(res));
      expect(parsed.error.code).toBe("invalid");
      expect(parsed.error.field).toBe("attempt");
    });

    it("validates leaseSeconds must be within MAX_QUEUE_VISIBILITY_SECONDS", async () => {
      const app = createQueueTestAppWithErrors();

      // Default max is 3600; try 3601
      const res = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-x",
          leaseSeconds: 3601,
        })
      ).expect(200);

      const parsed = JSON.parse(extractToolText(res));
      expect(parsed.error.code).toBe("invalid");
      expect(parsed.error.field).toBe("leaseSeconds");
    });

    it("validates leaseSeconds must be > 0", async () => {
      const app = createQueueTestAppWithErrors();

      const res = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-x",
          leaseSeconds: 0,
        })
      ).expect(200);

      const parsed = JSON.parse(extractToolText(res));
      expect(parsed.error.code).toBe("invalid");
      expect(parsed.error.field).toBe("leaseSeconds");
    });

    it("respects custom MAX_QUEUE_VISIBILITY_SECONDS env var", async () => {
      process.env.MAX_QUEUE_VISIBILITY_SECONDS = "120";

      const app = createQueueTestAppWithErrors();
      const res = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-x",
          leaseSeconds: 121,
        })
      ).expect(200);

      const parsed = JSON.parse(extractToolText(res));
      expect(parsed.error.code).toBe("invalid");
      expect(parsed.error.field).toBe("leaseSeconds");
      expect(parsed.error.message).toContain("120");
    });

    it("enforces 64 KiB body limit with too_large error", async () => {
      const app = createQueueTestAppWithErrors();

      // Create a body that exceeds 64 KiB when combined with patch
      const largeDetails: Record<string, string> = {};
      for (let i = 0; i < 1000; i++) {
        largeDetails[`key-${i}`] = "x".repeat(100);
      }

      const res = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-x",
          patch: { details: largeDetails },
        })
      ).expect(200);

      const parsed = JSON.parse(extractToolText(res));
      expect(parsed.error.code).toBe("too_large");
      expect(parsed.error.maxBytes).toBe(65536);
      expect(parsed.error.retryable).toBe(false);
    });

    it("works without messageText (empty body base)", async () => {
      mockUpdateMessage.mockResolvedValue({ popReceipt: "pop-new" });

      const app = createQueueTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-old",
          patch: { state: "queued", progress: 0 },
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.ok).toBe(true);
      expect(data.body.state).toBe("queued");
      expect(data.body.progress).toBe(0);
      expect(data.body.updatedAt).toBeDefined();
    });

    it("sets updatedAt timestamp on every update", async () => {
      mockUpdateMessage.mockResolvedValue({ popReceipt: "pop-ts" });

      const app = createQueueTestApp();
      const before = new Date().toISOString();
      const res = await mcpPost(
        app,
        toolCallRequest("queue-update-message", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-old",
          patch: { state: "running" },
        })
      ).expect(200);
      const after = new Date().toISOString();

      const data = extractToolJson(res);
      expect(data.body.updatedAt >= before).toBe(true);
      expect(data.body.updatedAt <= after).toBe(true);
    });
  });

  // ── queue-renew-lease ─────────────────────────────────────────────────

  describe("queue-renew-lease", () => {
    it("renews lease and returns new popReceipt", async () => {
      mockUpdateMessage.mockResolvedValue({ popReceipt: "pop-renewed" });

      const app = createQueueTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("queue-renew-lease", {
          queueName: "work-queue",
          messageId: "msg-50",
          popReceipt: "pop-old",
          leaseSeconds: 120,
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.ok).toBe(true);
      expect(data.messageId).toBe("msg-50");
      expect(data.popReceipt).toBe("pop-renewed");
      expect(data.leaseSeconds).toBe(120);

      // Verify Azure SDK call — empty body, 120s timeout
      expect(mockUpdateMessage).toHaveBeenCalledWith(
        "msg-50", "pop-old", "", 120
      );
    });

    it("preserves message body when messageText is provided", async () => {
      mockUpdateMessage.mockResolvedValue({ popReceipt: "pop-preserved" });

      const app = createQueueTestApp();
      const originalBody = JSON.stringify({ task: "important", progress: 50 });
      await mcpPost(
        app,
        toolCallRequest("queue-renew-lease", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-old",
          leaseSeconds: 60,
          messageText: originalBody,
        })
      ).expect(200);

      expect(mockUpdateMessage).toHaveBeenCalledWith(
        "m1", "pop-old", originalBody, 60
      );
    });

    it("enforces MAX_QUEUE_VISIBILITY_SECONDS", async () => {
      const app = createQueueTestAppWithErrors();

      const res = await mcpPost(
        app,
        toolCallRequest("queue-renew-lease", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-x",
          leaseSeconds: 3601,
        })
      ).expect(200);

      const parsed = JSON.parse(extractToolText(res));
      expect(parsed.error.code).toBe("invalid");
      expect(parsed.error.field).toBe("leaseSeconds");
    });

    it("rejects leaseSeconds <= 0", async () => {
      const app = createQueueTestAppWithErrors();

      const res = await mcpPost(
        app,
        toolCallRequest("queue-renew-lease", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-x",
          leaseSeconds: 0,
        })
      ).expect(200);

      const parsed = JSON.parse(extractToolText(res));
      expect(parsed.error.code).toBe("invalid");
      expect(parsed.error.field).toBe("leaseSeconds");
    });

    it("rejects non-integer leaseSeconds", async () => {
      const app = createQueueTestAppWithErrors();

      const res = await mcpPost(
        app,
        toolCallRequest("queue-renew-lease", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-x",
          leaseSeconds: 30.5,
        })
      ).expect(200);

      const parsed = JSON.parse(extractToolText(res));
      expect(parsed.error.code).toBe("invalid");
      expect(parsed.error.field).toBe("leaseSeconds");
    });

    it("respects custom MAX_QUEUE_VISIBILITY_SECONDS env var", async () => {
      process.env.MAX_QUEUE_VISIBILITY_SECONDS = "300";

      mockUpdateMessage.mockResolvedValue({ popReceipt: "pop-custom" });
      const app = createQueueTestApp();

      // 300 should be accepted
      const res = await mcpPost(
        app,
        toolCallRequest("queue-renew-lease", {
          queueName: "q",
          messageId: "m1",
          popReceipt: "pop-old",
          leaseSeconds: 300,
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.ok).toBe(true);
      expect(data.leaseSeconds).toBe(300);

      // 301 should be rejected
      const app2 = createQueueTestAppWithErrors();
      const res2 = await mcpPost(
        app2,
        toolCallRequest("queue-renew-lease", {
          queueName: "q",
          messageId: "m2",
          popReceipt: "pop-old",
          leaseSeconds: 301,
        })
      ).expect(200);

      const parsed = JSON.parse(extractToolText(res2));
      expect(parsed.error.code).toBe("invalid");
    });
  });
});
