/**
 * Test harness for MCP tool and resource testing.
 *
 * Creates a minimal Express app with a stateless MCP endpoint,
 * suitable for use with supertest. Azure SDK modules are mocked
 * at the vi.mock level before this helper is imported.
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Create a test Express app with a stateless MCP endpoint.
 * The provided `registerFn` registers tools or resources on the McpServer.
 */
export function createTestApp(
  registerFn: (server: McpServer) => void
): express.Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.post("/mcp", async (req, res) => {
    const mcpServer = new McpServer({
      name: "test-server",
      version: "1.0.0",
    });
    registerFn(mcpServer);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Internal error";
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message },
        });
      }
    } finally {
      try {
        await mcpServer.close();
      } catch {
        /* ignore */
      }
    }
  });

  return app;
}

/**
 * Parse a Server-Sent Events response text and extract JSON-RPC messages.
 * SSE format:
 *   event: message
 *   data: {"jsonrpc":"2.0","id":1,"result":{...}}
 *
 *   (blank line separates events)
 */
function parseSSE(text: string): any[] {
  const messages: any[] = [];
  const events = text.split("\n\n");
  for (const event of events) {
    const lines = event.trim().split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          messages.push(JSON.parse(line.slice(6)));
        } catch {
          // not valid JSON, skip
        }
      }
    }
  }
  return messages;
}

/**
 * Extract the JSON-RPC response from a supertest response.
 * Handles both direct JSON responses and SSE-wrapped responses.
 */
export function extractJsonRpcResponse(res: any): any {
  // If body has meaningful content (not empty object), use it directly
  if (res.body && Object.keys(res.body).length > 0) {
    return res.body;
  }

  // Otherwise parse as SSE
  if (res.text) {
    const messages = parseSSE(res.text);
    if (messages.length > 0) {
      return messages[0];
    }
  }

  throw new Error(
    `Could not extract JSON-RPC response. Status: ${res.status}, Body: ${JSON.stringify(res.body)}, Text: ${res.text?.substring(0, 200)}`
  );
}

/**
 * Send a JSON-RPC request to the MCP test endpoint with proper headers.
 * MCP Streamable HTTP requires Accept: application/json, text/event-stream
 */
export function mcpPost(app: express.Express, body: any) {
  // Use dynamic import to avoid issues with supertest types
  const supertest = require("supertest");
  return supertest(app)
    .post("/mcp")
    .set("Content-Type", "application/json")
    .set("Accept", "application/json, text/event-stream")
    .send(body);
}

/**
 * Build a JSON-RPC 2.0 tools/call request body.
 */
export function toolCallRequest(
  toolName: string,
  args: Record<string, unknown> = {},
  id: number | string = 1
) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };
}

/**
 * Build a JSON-RPC 2.0 tools/list request body.
 */
export function toolListRequest(id: number | string = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    params: {},
  };
}

/**
 * Build a JSON-RPC 2.0 resources/read request body.
 */
export function resourceReadRequest(
  uri: string,
  id: number | string = 1
) {
  return {
    jsonrpc: "2.0",
    id,
    method: "resources/read",
    params: { uri },
  };
}

/**
 * Build a JSON-RPC 2.0 resources/list request body.
 */
export function resourceListRequest(id: number | string = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "resources/list",
    params: {},
  };
}

/**
 * Extract the text content from a successful MCP tool call response.
 * Handles both JSON and SSE response formats.
 */
export function extractToolText(resOrBody: any): string {
  // If this looks like a supertest response object (has .body and .text)
  const body = resOrBody.body !== undefined && resOrBody.text !== undefined
    ? extractJsonRpcResponse(resOrBody)
    : resOrBody;

  const result = body?.result;
  if (result?.content?.[0]?.text) {
    return result.content[0].text;
  }
  throw new Error(
    `Could not extract tool text from response: ${JSON.stringify(body)}`
  );
}

/**
 * Extract parsed JSON from a successful MCP tool call response.
 * Handles both JSON and SSE response formats.
 */
export function extractToolJson(resOrBody: any): any {
  return JSON.parse(extractToolText(resOrBody));
}

/**
 * Extract resource contents from a successful MCP resources/read response.
 * Handles both JSON and SSE response formats.
 */
export function extractResourceContents(resOrBody: any): any[] {
  const body = resOrBody.body !== undefined && resOrBody.text !== undefined
    ? extractJsonRpcResponse(resOrBody)
    : resOrBody;

  const contents = body?.result?.contents;
  if (contents) {
    return contents;
  }
  throw new Error(
    `Could not extract resource contents from response: ${JSON.stringify(body)}`
  );
}

/**
 * Extract the tools array from a tools/list response.
 * Handles both JSON and SSE response formats.
 */
export function extractToolsList(resOrBody: any): any[] {
  const body = resOrBody.body !== undefined && resOrBody.text !== undefined
    ? extractJsonRpcResponse(resOrBody)
    : resOrBody;

  const tools = body?.result?.tools;
  if (tools) {
    return tools;
  }
  throw new Error(
    `Could not extract tools list from response: ${JSON.stringify(body)}`
  );
}

/**
 * Extract the resources array from a resources/list response.
 * Handles both JSON and SSE response formats.
 */
export function extractResourcesList(resOrBody: any): any[] {
  const body = resOrBody.body !== undefined && resOrBody.text !== undefined
    ? extractJsonRpcResponse(resOrBody)
    : resOrBody;

  const resources = body?.result?.resources;
  if (resources) {
    return resources;
  }
  throw new Error(
    `Could not extract resources list from response: ${JSON.stringify(body)}`
  );
}
