/**
 * Unit tests for src/resources/queue-resources.ts
 *
 * Uses vi.hoisted() because queue-resources.ts creates its service client
 * at module scope, so mocks must be ready before module evaluation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockListQueues, mockGetProperties } = vi.hoisted(() => ({
  mockListQueues: vi.fn(),
  mockGetProperties: vi.fn(),
}));

vi.mock("@azure/storage-queue", () => {
  return {
    StorageSharedKeyCredential: vi.fn().mockImplementation(() => ({})),
    QueueServiceClient: vi.fn().mockImplementation(() => ({
      listQueues: mockListQueues,
      getQueueClient: vi.fn().mockImplementation(() => ({
        getProperties: mockGetProperties,
      })),
    })),
  };
});

import {
  createTestApp,
  mcpPost,
  resourceReadRequest,
  extractResourceContents,
} from "../helpers/mcp-test-harness.js";
import { registerQueueResources } from "../../src/resources/queue-resources.js";

function createQueueResourceApp() {
  return createTestApp((server) => registerQueueResources(server));
}

describe("queue-resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("azure-queue:///queues (list queues)", () => {
    it("returns queue list with index", async () => {
      mockListQueues.mockImplementation(async function* () {
        yield { name: "orders" };
        yield { name: "notifications" };
      });

      const app = createQueueResourceApp();
      const res = await mcpPost(app, resourceReadRequest("azure-queue:///queues")).expect(200);

      const contents = extractResourceContents(res);
      const data = JSON.parse(contents[0].text);
      expect(data).toHaveLength(2);
      expect(data[0]).toEqual({ name: "orders", index: 1 });
    });

    it("caps list at MAX_LIST_ITEMS", async () => {
      mockListQueues.mockImplementation(async function* () {
        for (let i = 0; i < 600; i++) {
          yield { name: `queue-${i}` };
        }
      });

      const app = createQueueResourceApp();
      const res = await mcpPost(app, resourceReadRequest("azure-queue:///queues")).expect(200);

      const contents = extractResourceContents(res);
      const data = JSON.parse(contents[0].text);
      expect(data.length).toBeLessThanOrEqual(500);
    });
  });

  describe("azure-queue:///queues/{name}/properties", () => {
    it("returns queue properties with message count", async () => {
      mockGetProperties.mockResolvedValue({
        approximateMessagesCount: 42,
        metadata: { env: "test" },
      });

      const app = createQueueResourceApp();
      const res = await mcpPost(
        app,
        resourceReadRequest("azure-queue:///queues/orders/properties")
      ).expect(200);

      const contents = extractResourceContents(res);
      const data = JSON.parse(contents[0].text);
      expect(data.name).toBe("orders");
      expect(data.approximateMessagesCount).toBe(42);
      expect(data.metadata.env).toBe("test");
    });
  });
});
