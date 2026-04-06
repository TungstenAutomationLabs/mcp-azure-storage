import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  TableServiceClient,
  TableClient,
  AzureNamedKeyCredential,
} from "@azure/data-tables";
import { getStorageConfig } from "../config.js";

export function registerTableTools(server: McpServer): void {
  const config = getStorageConfig();

  function getTableServiceClient(): TableServiceClient {
    const credential = new AzureNamedKeyCredential(
      config.accountName,
      config.accountKey
    );
    return new TableServiceClient(
      `https://${config.accountName}.table.core.windows.net`,
      credential
    );
  }

  function getTableClient(tableName: string): TableClient {
    const credential = new AzureNamedKeyCredential(
      config.accountName,
      config.accountKey
    );
    return new TableClient(
      `https://${config.accountName}.table.core.windows.net`,
      tableName,
      credential
    );
  }

  // ── TABLE MANAGEMENT ──

  server.tool("table-list", "List all tables in the storage account", {}, async () => {
    const client = getTableServiceClient();
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
    "Create a table if it doesn't already exist",
    { tableName: z.string().describe("Table name to create") },
    async ({ tableName }) => {
      const client = getTableServiceClient();
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
    "Delete a table",
    { tableName: z.string().describe("Table name to delete") },
    async ({ tableName }) => {
      const client = getTableServiceClient();
      await client.deleteTable(tableName);
      return {
        content: [
          { type: "text", text: `Deleted table "${tableName}".` },
        ],
      };
    }
  );

  // ── ENTITY CRUD ──

  server.tool(
    "table-entity-upsert",
    "Insert or update (merge) an entity in a table",
    {
      tableName: z.string().describe("Table name"),
      partitionKey: z.string().describe("Partition key"),
      rowKey: z.string().describe("Row key"),
      entity: z
        .record(z.string(), z.unknown())
        .describe("Entity properties as key-value pairs"),
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
    "Get a single entity by partition key and row key",
    {
      tableName: z.string().describe("Table name"),
      partitionKey: z.string().describe("Partition key"),
      rowKey: z.string().describe("Row key"),
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
    "Query entities using an OData filter expression",
    {
      tableName: z.string().describe("Table name"),
      filter: z
        .string()
        .optional()
        .describe("OData filter, e.g. \"PartitionKey eq 'sales'\""),
      top: z
        .number()
        .optional()
        .default(100)
        .describe("Max number of results to return"),
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
    "Delete an entity by partition key and row key",
    {
      tableName: z.string().describe("Table name"),
      partitionKey: z.string().describe("Partition key"),
      rowKey: z.string().describe("Row key"),
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
