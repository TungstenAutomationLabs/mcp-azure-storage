/**
 * Azure Table Storage MCP tools — 7 tools.
 *
 * Provides table management (list, create, delete) and entity CRUD
 * (upsert, get, query, delete).
 *
 * Table Storage is a schemaless NoSQL key-value store. Each entity is
 * identified by a composite key: (partitionKey, rowKey). Entities within
 * the same partition are stored together for efficient querying.
 *
 * The upsert operation uses "Merge" semantics — existing properties not
 * included in the request are preserved (not deleted).
 *
 * @module tools/table-tools
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  TableServiceClient,
  TableClient,
  AzureNamedKeyCredential,
} from "@azure/data-tables";
import { getStorageConfig } from "../config.js";

/**
 * Register all 7 Table Storage tools on the given MCP server.
 *
 * Creates a singleton TableServiceClient for management operations and
 * caches per-table TableClients for entity operations.
 */
export function registerTableTools(server: McpServer): void {
  const config = getStorageConfig();

  // Singleton credential + service client — shared across all table management calls.
  const credential = new AzureNamedKeyCredential(
    config.accountName,
    config.accountKey
  );
  const tableServiceUrl =
    config.tableServiceUrl || `https://${config.accountName}.table.core.windows.net`;
  const tableServiceClient = new TableServiceClient(tableServiceUrl, credential);

  // Per-table clients are cached in a Map. Unlike the service client,
  // TableClient is scoped to a single table, so we create one per table
  // name and reuse it for all entity operations on that table.
  const tableClientCache = new Map<string, TableClient>();

  /**
   * Get or create a cached TableClient for the given table name.
   *
   * @param tableName - The table to get a client for.
   * @returns A reusable TableClient instance.
   */
  function getTableClient(tableName: string): TableClient {
    let client = tableClientCache.get(tableName);
    if (!client) {
      // Evict oldest entry if cache is full (simple FIFO eviction)
      if (tableClientCache.size >= 100) {
        const oldestKey = tableClientCache.keys().next().value;
        if (oldestKey) tableClientCache.delete(oldestKey);
      }
      client = new TableClient(tableServiceUrl, tableName, credential);
      tableClientCache.set(tableName, client);
    }
    return client;
  }

  // ── TABLE MANAGEMENT ─────────────────────────────────────────────────────

  server.tool("table-list", "List all tables in the storage account. Use this to discover available tables before performing entity operations. Returns an array of objects with 'name' and 'index' (1-based) for each table.", {}, async () => {
    const client = tableServiceClient;
    const tables: { name: string; index: number }[] = [];
    let i = 1;
    for await (const table of client.listTables()) {
      if (table.name) {
        tables.push({ name: table.name, index: i++ });
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify(tables, null, 2) }],
    };
  });

  server.tool(
    "table-create",
    "Create a new table if it doesn't already exist. Idempotent — returns a message indicating whether the table was created or already existed. Use this before upserting entities to a new table.",
    { tableName: z.string().describe("Table name to create (letters and digits only, 3-63 chars, must start with a letter, e.g. 'OrderHistory')") },
    async ({ tableName }) => {
      const client = tableServiceClient;
      let status = "";
      await client.createTable(tableName, {
        onResponse: (response) => {
          status =
            response.status === 409
              ? `Table "${tableName}" already exists.`
              : `Created table "${tableName}".`;
        },
      });
      return { content: [{ type: "text", text: status }] };
    }
  );

  server.tool(
    "table-delete",
    "Permanently delete a table and ALL entities inside it. WARNING: This is irreversible — all rows will be lost. Use 'table-entity-query' to inspect contents before deleting.",
    { tableName: z.string().describe("Name of the table to delete (e.g. 'OrderHistory')") },
    async ({ tableName }) => {
      const client = tableServiceClient;
      await client.deleteTable(tableName);
      return {
        content: [
          { type: "text", text: `Deleted table "${tableName}".` },
        ],
      };
    }
  );

  // ── ENTITY CRUD ──────────────────────────────────────────────────────────
  // Entities are identified by (partitionKey, rowKey). All entity operations
  // use the cached per-table TableClient for connection reuse.

  server.tool(
    "table-entity-upsert",
    "Insert a new entity or merge-update an existing entity in a table (upsert with merge semantics). " +
      "If an entity with the same partitionKey+rowKey exists, only the supplied properties are updated — existing properties not in the request are preserved. " +
      "Provide partitionKey and rowKey as separate parameters; all other properties go in the 'entity' object. " +
      "Supported value types: string, number, boolean. Returns JSON with 'success', 'partitionKey', and 'rowKey'.",
    {
      tableName: z.string().describe("Name of the table (e.g. 'OrderHistory')"),
      partitionKey: z.string().describe("Partition key — groups related entities for efficient querying (e.g. 'sales-region-west')"),
      rowKey: z.string().describe("Row key — unique identifier within the partition (e.g. 'order-20240315-001')"),
      entity: z
        .record(z.string(), z.unknown())
        .describe(
          'Flat JSON object of property name→value pairs (e.g. {"email": "a@b.com", "score": 95, "verified": true}). ' +
          "Do NOT include partitionKey or rowKey here — they are separate parameters."
        ),
    },
    async ({ tableName, partitionKey, rowKey, entity }) => {
      const client = getTableClient(tableName);
      const fullEntity = { partitionKey, rowKey, ...entity };
      await client.upsertEntity(fullEntity, "Merge");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              partitionKey,
              rowKey,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "table-entity-get",
    "Retrieve a single entity by its exact partition key and row key. This is the fastest way to look up a specific entity — use it when you know both keys. Returns the full entity object with all properties, including system fields (timestamp, etag).",
    {
      tableName: z.string().describe("Name of the table (e.g. 'OrderHistory')"),
      partitionKey: z.string().describe("Partition key of the entity to retrieve (e.g. 'sales-region-west')"),
      rowKey: z.string().describe("Row key of the entity to retrieve (e.g. 'order-20240315-001')"),
    },
    async ({ tableName, partitionKey, rowKey }) => {
      const client = getTableClient(tableName);
      const entity = await client.getEntity(partitionKey, rowKey);
      return {
        content: [{ type: "text", text: JSON.stringify(entity, null, 2) }],
      };
    }
  );

  server.tool(
    "table-entity-query",
    "Query entities in a table using an OData filter expression. Use this to search for entities matching specific criteria. Omit the filter to return all entities (up to 'top' limit). Returns JSON with 'count' and an 'entities' array. Common OData operators: eq, ne, gt, ge, lt, le, and, or, not.",
    {
      tableName: z.string().describe("Name of the table (e.g. 'OrderHistory')"),
      filter: z
        .string()
        .optional()
        .describe("OData filter expression (e.g. \"PartitionKey eq 'sales'\" or \"score gt 90 and verified eq true\"). Omit to return all entities."),
      top: z
        .number()
        .optional()
        .default(100)
        .describe("Maximum number of entities to return (default: 100). Use smaller values for faster responses."),
    },
    async ({ tableName, filter, top }) => {
      const client = getTableClient(tableName);
      const entities: Record<string, unknown>[] = [];
      const queryOptions: { queryOptions?: { filter?: string } } = {};
      if (filter) {
        queryOptions.queryOptions = { filter };
      }

      let count = 0;
      for await (const entity of client.listEntities(queryOptions)) {
        if (count >= top) break;
        entities.push(entity as Record<string, unknown>);
        count++;
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: entities.length, entities }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "table-entity-delete",
    "Permanently delete a single entity by its partition key and row key. WARNING: This is irreversible. Use 'table-entity-get' to verify the entity exists before deleting. Returns JSON with 'success' and the deleted key pair.",
    {
      tableName: z.string().describe("Name of the table (e.g. 'OrderHistory')"),
      partitionKey: z.string().describe("Partition key of the entity to delete (e.g. 'sales-region-west')"),
      rowKey: z.string().describe("Row key of the entity to delete (e.g. 'order-20240315-001')"),
    },
    async ({ tableName, partitionKey, rowKey }) => {
      const client = getTableClient(tableName);
      await client.deleteEntity(partitionKey, rowKey);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, deleted: { partitionKey, rowKey } }),
          },
        ],
      };
    }
  );
}
