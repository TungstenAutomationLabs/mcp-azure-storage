/**
 * Unit tests for src/resources/table-resources.ts
 *
 * Uses vi.hoisted() because table-resources.ts creates its service client
 * at module scope, so mocks must be ready before module evaluation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockListTables, mockGetEntity } = vi.hoisted(() => ({
  mockListTables: vi.fn(),
  mockGetEntity: vi.fn(),
}));

vi.mock("@azure/data-tables", () => {
  return {
    AzureNamedKeyCredential: vi.fn().mockImplementation(() => ({})),
    TableServiceClient: vi.fn().mockImplementation(() => ({
      listTables: mockListTables,
    })),
    TableClient: vi.fn().mockImplementation(() => ({
      getEntity: mockGetEntity,
    })),
  };
});

import {
  createTestApp,
  mcpPost,
  resourceReadRequest,
  extractResourceContents,
} from "../helpers/mcp-test-harness.js";
import { registerTableResources } from "../../src/resources/table-resources.js";

function createTableResourceApp() {
  return createTestApp((server) => registerTableResources(server));
}

describe("table-resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("azure-table:///tables (list tables)", () => {
    it("returns table list with index", async () => {
      mockListTables.mockImplementation(async function* () {
        yield { name: "Orders" };
        yield { name: "Users" };
      });

      const app = createTableResourceApp();
      const res = await mcpPost(app, resourceReadRequest("azure-table:///tables")).expect(200);

      const contents = extractResourceContents(res);
      const data = JSON.parse(contents[0].text);
      expect(data).toHaveLength(2);
      expect(data[0]).toEqual({ name: "Orders", index: 1 });
    });

    it("caps list at MAX_LIST_ITEMS", async () => {
      mockListTables.mockImplementation(async function* () {
        for (let i = 0; i < 600; i++) {
          yield { name: `Table${i}` };
        }
      });

      const app = createTableResourceApp();
      const res = await mcpPost(app, resourceReadRequest("azure-table:///tables")).expect(200);

      const contents = extractResourceContents(res);
      const data = JSON.parse(contents[0].text);
      expect(data.length).toBeLessThanOrEqual(500);
    });
  });

  describe("azure-table:///tables/{name}/entities/{pk}/{rk}", () => {
    it("returns entity by composite key", async () => {
      mockGetEntity.mockResolvedValue({
        partitionKey: "region-west",
        rowKey: "order-001",
        total: 99.95,
        timestamp: "2024-01-01T00:00:00Z",
      });

      const app = createTableResourceApp();
      const res = await mcpPost(
        app,
        resourceReadRequest("azure-table:///tables/Orders/entities/region-west/order-001")
      ).expect(200);

      const contents = extractResourceContents(res);
      const data = JSON.parse(contents[0].text);
      expect(data.partitionKey).toBe("region-west");
      expect(data.rowKey).toBe("order-001");
      expect(data.total).toBe(99.95);
    });
  });
});
