/**
 * @module table-resources
 *
 * MCP Resource definitions for Azure Table Storage read-only operations.
 *
 * Exposes 2 resources:
 *   - `azure-table:///tables`                                         — list all tables
 *   - `azure-table:///tables/{tableName}/entities/{partitionKey}/{rowKey}` — get single entity
 *
 * Note: `table-query-entities` is not exposed as a resource because its
 * complex OData filter parameters don't map cleanly to URI templates.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  TableServiceClient,
  TableClient,
  AzureNamedKeyCredential,
} from "@azure/data-tables";
import { getStorageConfig } from "../config.js";

// ── Singleton Table Service Client ─────────────────────────────
const config = getStorageConfig();
const tableCredential = new AzureNamedKeyCredential(config.accountName, config.accountKey);
const tableServiceUrl =
  config.tableServiceUrl || `https://${config.accountName}.table.core.windows.net`;
const tableServiceClient = new TableServiceClient(tableServiceUrl, tableCredential);

/** Maximum number of items returned by listing resources to prevent oversized responses. */
const MAX_LIST_ITEMS = 500;

/** Maximum number of cached TableClient instances to prevent unbounded memory growth. */
const MAX_TABLE_CLIENT_CACHE = 100;

/** Cache of TableClient instances keyed by table name. */
const tableClientCache = new Map<string, TableClient>();

/**
 * Returns a cached TableClient for the given table name, creating one if needed.
 */
function getTableClient(tableName: string): TableClient {
  let client = tableClientCache.get(tableName);
  if (!client) {
    // Evict oldest entry if cache is full (simple FIFO eviction)
    if (tableClientCache.size >= MAX_TABLE_CLIENT_CACHE) {
      const oldestKey = tableClientCache.keys().next().value;
      if (oldestKey) tableClientCache.delete(oldestKey);
    }
    client = new TableClient(tableServiceUrl, tableName, tableCredential);
    tableClientCache.set(tableName, client);
  }
  return client;
}

/**
 * Registers all Table Storage MCP resources on the given server instance.
 *
 * @param server - The McpServer to register resources on.
 */
export function registerTableResources(server: McpServer): void {
  // ── 1. List Tables (static resource) ───────────────────────
  server.resource(
    "table-list",
    "azure-table:///tables",
    {
      description: "List all tables in the storage account. Use this to discover which tables exist before querying or upserting entities via the table tools. Returns a JSON array of objects with 'name' (table name) and 'index' (1-based position).",
      mimeType: "application/json",
    },
    async (uri) => {
      const tables: { name: string; index: number }[] = [];
      let index = 1;
      for await (const table of tableServiceClient.listTables()) {
        if (table.name) {
          tables.push({ name: table.name, index: index++ });
        }
        if (index > MAX_LIST_ITEMS) break;
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(tables, null, 2),
          },
        ],
      };
    }
  );

  // ── 2. Get Entity (template resource) ──────────────────────
  server.resource(
    "table-get-entity",
    new ResourceTemplate(
      "azure-table:///tables/{tableName}/entities/{partitionKey}/{rowKey}",
      { list: undefined } // Cannot enumerate all entities efficiently
    ),
    {
      description: "Get a single table entity by its composite key (partitionKey + rowKey). Use this when you know the exact entity to retrieve — it is faster than a query. Returns the full entity as a JSON object including all custom properties, partitionKey, rowKey, and timestamp. For bulk retrieval or filtered searches, use the table-query-entities tool instead.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const tableName = String(variables.tableName);
      const partitionKey = String(variables.partitionKey);
      const rowKey = String(variables.rowKey);
      const client = getTableClient(tableName);
      const entity = await client.getEntity(partitionKey, rowKey);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(entity, null, 2),
          },
        ],
      };
    }
  );
}
