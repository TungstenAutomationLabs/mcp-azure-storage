/**
 * Unit tests for src/tools/table-tools.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Azure Data Tables SDK ───────────────────────────────────────────
const mockListTables = vi.fn();
const mockCreateTable = vi.fn();
const mockDeleteTable = vi.fn();
const mockUpsertEntity = vi.fn();
const mockGetEntity = vi.fn();
const mockListEntities = vi.fn();
const mockDeleteEntity = vi.fn();

vi.mock("@azure/data-tables", () => {
  return {
    AzureNamedKeyCredential: vi.fn().mockImplementation(() => ({})),
    TableServiceClient: vi.fn().mockImplementation(() => ({
      listTables: mockListTables,
      createTable: mockCreateTable,
      deleteTable: mockDeleteTable,
    })),
    TableClient: vi.fn().mockImplementation(() => ({
      upsertEntity: mockUpsertEntity,
      getEntity: mockGetEntity,
      listEntities: mockListEntities,
      deleteEntity: mockDeleteEntity,
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
import { registerTableTools } from "../../src/tools/table-tools.js";

function createTableTestApp() {
  return createTestApp((server) => registerTableTools(server));
}

describe("table-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tool registration", () => {
    it("registers 7 table tools", async () => {
      const app = createTableTestApp();
      const res = await mcpPost(app, toolListRequest()).expect(200);

      const tools = extractToolsList(res);
      expect(tools).toHaveLength(7);
    });
  });

  describe("table-list", () => {
    it("returns tables with name and index", async () => {
      mockListTables.mockImplementation(async function* () {
        yield { name: "Orders" };
        yield { name: "Users" };
      });

      const app = createTableTestApp();
      const res = await mcpPost(app, toolCallRequest("table-list")).expect(200);

      const data = extractToolJson(res);
      expect(data).toHaveLength(2);
      expect(data[0]).toEqual({ name: "Orders", index: 1 });
      expect(data[1]).toEqual({ name: "Users", index: 2 });
    });
  });

  describe("table-create", () => {
    it("creates table and reports status via onResponse", async () => {
      mockCreateTable.mockImplementation(
        async (tableName: string, options: any) => {
          if (options?.onResponse) {
            options.onResponse({ status: 204 });
          }
        }
      );

      const app = createTableTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("table-create", { tableName: "NewTable" })
      ).expect(200);

      const text = extractToolText(res);
      expect(text).toContain("Created");
      expect(text).toContain("NewTable");
    });

    it("reports table already exists via 409 onResponse", async () => {
      mockCreateTable.mockImplementation(
        async (tableName: string, options: any) => {
          if (options?.onResponse) {
            options.onResponse({ status: 409 });
          }
        }
      );

      const app = createTableTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("table-create", { tableName: "ExistingTable" })
      ).expect(200);

      const text = extractToolText(res);
      expect(text).toContain("already exists");
    });
  });

  describe("table-entity-upsert", () => {
    it("upserts entity with merge semantics", async () => {
      mockUpsertEntity.mockResolvedValue({});

      const app = createTableTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("table-entity-upsert", {
          tableName: "Users",
          partitionKey: "region-west",
          rowKey: "user-001",
          entity: { email: "a@b.com", score: 95 },
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.success).toBe(true);
      expect(data.partitionKey).toBe("region-west");
      expect(data.rowKey).toBe("user-001");

      expect(mockUpsertEntity).toHaveBeenCalledWith(
        {
          partitionKey: "region-west",
          rowKey: "user-001",
          email: "a@b.com",
          score: 95,
        },
        "Merge"
      );
    });
  });

  describe("table-entity-get", () => {
    it("returns full entity", async () => {
      mockGetEntity.mockResolvedValue({
        partitionKey: "region-west",
        rowKey: "user-001",
        email: "a@b.com",
        timestamp: "2024-01-01T00:00:00Z",
      });

      const app = createTableTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("table-entity-get", {
          tableName: "Users",
          partitionKey: "region-west",
          rowKey: "user-001",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.partitionKey).toBe("region-west");
      expect(data.email).toBe("a@b.com");
    });
  });

  describe("table-entity-query", () => {
    it("queries with OData filter and top limit", async () => {
      mockListEntities.mockImplementation(async function* () {
        yield { partitionKey: "a", rowKey: "1", score: 99 };
        yield { partitionKey: "a", rowKey: "2", score: 95 };
      });

      const app = createTableTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("table-entity-query", {
          tableName: "Users",
          filter: "score gt 90",
          top: 10,
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.count).toBe(2);
      expect(data.entities).toHaveLength(2);
    });

    it("respects top limit", async () => {
      mockListEntities.mockImplementation(async function* () {
        yield { partitionKey: "a", rowKey: "1" };
        yield { partitionKey: "a", rowKey: "2" };
        yield { partitionKey: "a", rowKey: "3" };
      });

      const app = createTableTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("table-entity-query", {
          tableName: "Users",
          top: 2,
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.count).toBe(2);
    });
  });

  describe("table-entity-delete", () => {
    it("deletes entity by key pair", async () => {
      mockDeleteEntity.mockResolvedValue({});

      const app = createTableTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("table-entity-delete", {
          tableName: "Users",
          partitionKey: "region-west",
          rowKey: "user-001",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.success).toBe(true);
      expect(data.deleted.partitionKey).toBe("region-west");
      expect(data.deleted.rowKey).toBe("user-001");
    });
  });
});
