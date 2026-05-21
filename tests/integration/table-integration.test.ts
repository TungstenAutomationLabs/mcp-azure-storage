/**
 * Integration tests for table tools against Azurite.
 *
 * Requirements:
 *   1. Azurite running: docker compose -f docker-compose.azurite.yml up -d
 *   2. Environment: TEST_INTEGRATION=1
 *   3. .env.test loaded via tests/setup.ts
 *
 * Run: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  TableServiceClient,
  AzureNamedKeyCredential,
} from "@azure/data-tables";
import {
  createTestApp,
  mcpPost,
  toolCallRequest,
  resourceReadRequest,
  extractToolText,
  extractToolJson,
  extractResourceContents,
} from "../helpers/mcp-test-harness.js";
import { registerTableTools } from "../../src/tools/table-tools.js";
import { registerTableResources } from "../../src/resources/table-resources.js";

const SKIP = !process.env.TEST_INTEGRATION;

describe.skipIf(SKIP)("table-tools integration (Azurite)", () => {
  const tableName = `TestInt${Date.now()}`;
  let app: ReturnType<typeof createTestApp>;
  let tableServiceClient: TableServiceClient;

  beforeAll(async () => {
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME!;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY!;
    const url = process.env.AZURE_TABLE_SERVICE_URL!;

    const credential = new AzureNamedKeyCredential(accountName, accountKey);
    const isInsecure = url.startsWith("http://");
    const clientOptions = isInsecure ? { allowInsecureConnection: true } : {};
    tableServiceClient = new TableServiceClient(url, credential, clientOptions);

    app = createTestApp((server) => {
      registerTableTools(server);
      registerTableResources(server);
    });
  });

  afterAll(async () => {
    try {
      await tableServiceClient.deleteTable(tableName);
    } catch {
      /* best-effort cleanup */
    }
  });

  it("creates a table via table-create", async () => {
    const res = await mcpPost(
      app,
      toolCallRequest("table-create", { tableName })
    ).expect(200);

    const text = extractToolText(res);
    expect(text).toContain(tableName);
  });

  it("lists tables including the new one", async () => {
    const res = await mcpPost(
      app,
      resourceReadRequest("azure-table:///tables")
    ).expect(200);

    const contents = extractResourceContents(res);
    const data = JSON.parse(contents[0].text);
    const names = data.map((t: any) => t.name);
    expect(names).toContain(tableName);
  });

  it("upserts and retrieves an entity", async () => {
    // Upsert
    const upsertRes = await mcpPost(
      app,
      toolCallRequest("table-entity-upsert", {
        tableName,
        partitionKey: "region-west",
        rowKey: "order-001",
        entity: { total: 99.95, status: "shipped" },
      })
    ).expect(200);

    const upsertData = extractToolJson(upsertRes);
    expect(upsertData.success).toBe(true);

    // Get via resource
    const getRes = await mcpPost(
      app,
      resourceReadRequest(`azure-table:///tables/${tableName}/entities/region-west/order-001`)
    ).expect(200);

    const contents = extractResourceContents(getRes);
    const entity = JSON.parse(contents[0].text);
    expect(entity.total).toBe(99.95);
    expect(entity.status).toBe("shipped");
  });

  it("queries entities with OData filter", async () => {
    // Add another entity
    await mcpPost(
      app,
      toolCallRequest("table-entity-upsert", {
        tableName,
        partitionKey: "region-west",
        rowKey: "order-002",
        entity: { total: 45.0, status: "pending" },
      })
    ).expect(200);

    const res = await mcpPost(
      app,
      toolCallRequest("table-entity-query", {
        tableName,
        filter: "total gt 50",
      })
    ).expect(200);

    const data = extractToolJson(res);
    expect(data.count).toBe(1);
    expect(data.entities[0].rowKey).toBe("order-001");
  });

  it("deletes an entity", async () => {
    const res = await mcpPost(
      app,
      toolCallRequest("table-entity-delete", {
        tableName,
        partitionKey: "region-west",
        rowKey: "order-002",
      })
    ).expect(200);

    const data = extractToolJson(res);
    expect(data.success).toBe(true);
  });

  it("deletes the table", async () => {
    const res = await mcpPost(
      app,
      toolCallRequest("table-delete", { tableName })
    ).expect(200);

    const text = extractToolText(res);
    expect(text).toContain("deleted");
  });
});
