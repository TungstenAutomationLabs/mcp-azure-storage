/**
 * Tests for stateless Streamable HTTP transport.
 *
 * Verifies that the MCP server operates correctly in fully stateless mode:
 *  - Every request is self-contained (no session state across requests)
 *  - Multiple "replicas" (separate handler instances) all succeed independently
 *  - Unknown Mcp-Session-Id headers are ignored gracefully (no 404)
 *  - GET /mcp and DELETE /mcp return 405 in stateless mode
 *  - initialize + tools/list both work as standalone requests
 *
 * Uses the same pattern as the existing test harness to avoid module
 * resolution issues with the MCP SDK.
 */

import express from "express";
import supertest from "supertest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------------------------------------------------------------------------
// Helper: parse Server-Sent Events text into JSON-RPC messages
// ---------------------------------------------------------------------------
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

/** Extract the JSON-RPC response from a supertest result (JSON or SSE). */
function extractResponse(res: any): any {
  if (res.body && Object.keys(res.body).length > 0) {
    return res.body;
  }
  if (res.text) {
    const msgs = parseSSE(res.text);
    if (msgs.length > 0) return msgs[0];
  }
  throw new Error(
    `Could not extract JSON-RPC response. Status: ${res.status}, Text: ${res.text?.substring(0, 200)}`
  );
}

// ---------------------------------------------------------------------------
// Helper: create a minimal stateless MCP app (simulates one "replica")
// ---------------------------------------------------------------------------
function createStatelessApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/mcp", async (req, res) => {
    const mcpServer = new McpServer({
      name: "test-stateless-server",
      version: "1.0.0",
    });

    // Register a simple test tool using Zod schema (required by SDK v1.29+)
    mcpServer.tool(
      "echo",
      "Echo back a message",
      { message: z.string() },
      async (args: { message: string }) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ echo: args.message }) }],
      })
    );

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
      try { await mcpServer.close(); } catch { /* ignore */ }
    }
  });

  // GET /mcp returns 405 (stateless -- no SSE)
  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Server operates in stateless mode. SSE streams are not supported.",
      },
    });
  });

  // DELETE /mcp returns 405 (stateless -- no sessions to terminate)
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Server operates in stateless mode. There are no sessions to terminate.",
      },
    });
  });

  return app;
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Stateless Streamable HTTP transport", () => {
  describe("basic stateless operation", () => {
    it("handles initialize as a standalone request", async () => {
      const app = createStatelessApp();

      const res = await supertest(app)
        .post("/mcp")
        .set("Accept", "application/json, text/event-stream")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            clientInfo: { name: "test-client", version: "1.0.0" },
            capabilities: {},
          },
        });

      // Should succeed (200 or SSE with result)
      expect(res.status).toBeLessThan(300);
      const body = extractResponse(res);
      expect(body.result).toBeDefined();
      expect(body.result.serverInfo).toBeDefined();
    });

    it("handles tools/list without prior initialize", async () => {
      const app = createStatelessApp();

      const res = await supertest(app)
        .post("/mcp")
        .set("Accept", "application/json, text/event-stream")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        });

      expect(res.status).toBeLessThan(300);
      const body = extractResponse(res);
      expect(body.result).toBeDefined();
      expect(body.result.tools).toBeDefined();
      expect(Array.isArray(body.result.tools)).toBe(true);
      // The echo tool should be listed
      const toolNames = body.result.tools.map((t: any) => t.name);
      expect(toolNames).toContain("echo");
    });

    it("handles tools/call without prior initialize", async () => {
      const app = createStatelessApp();

      const res = await supertest(app)
        .post("/mcp")
        .set("Accept", "application/json, text/event-stream")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo", arguments: { message: "hello" } },
        });

      expect(res.status).toBeLessThan(300);
      const body = extractResponse(res);
      expect(body.result).toBeDefined();
      const text = body.result.content[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.echo).toBe("hello");
    });

    it("does NOT return Mcp-Session-Id header in responses", async () => {
      const app = createStatelessApp();

      const res = await supertest(app)
        .post("/mcp")
        .set("Accept", "application/json, text/event-stream")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        });

      expect(res.status).toBeLessThan(300);
      // In stateless mode (no sessionIdGenerator), the SDK must not set this header
      expect(res.headers["mcp-session-id"]).toBeUndefined();
    });
  });

  describe("cross-replica stateless operation", () => {
    it("succeeds when requests are sent to different replicas", async () => {
      // Simulate two separate server replicas
      const replica1 = createStatelessApp();
      const replica2 = createStatelessApp();

      // Send initialize to replica 1
      const initRes = await supertest(replica1)
        .post("/mcp")
        .set("Accept", "application/json, text/event-stream")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            clientInfo: { name: "test-client", version: "1.0.0" },
            capabilities: {},
          },
        });

      expect(initRes.status).toBeLessThan(300);

      // Send tools/list to replica 2 (different instance, no shared state)
      const listRes = await supertest(replica2)
        .post("/mcp")
        .set("Accept", "application/json, text/event-stream")
        .send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        });

      expect(listRes.status).toBeLessThan(300);
      const listBody = extractResponse(listRes);
      expect(listBody.result.tools).toBeDefined();
      expect(Array.isArray(listBody.result.tools)).toBe(true);

      // Send tools/call to replica 2 (again, no prior state from replica 1)
      const callRes = await supertest(replica2)
        .post("/mcp")
        .set("Accept", "application/json, text/event-stream")
        .send({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "echo", arguments: { message: "from replica 2" } },
        });

      expect(callRes.status).toBeLessThan(300);
      const callBody = extractResponse(callRes);
      const text = callBody.result.content[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.echo).toBe("from replica 2");
    });

    it("each replica independently handles initialize", async () => {
      const replicas = [createStatelessApp(), createStatelessApp(), createStatelessApp()];

      // Send initialize to all three replicas in parallel
      const results = await Promise.all(
        replicas.map((replica, i) =>
          supertest(replica)
            .post("/mcp")
            .set("Accept", "application/json, text/event-stream")
            .send({
              jsonrpc: "2.0",
              id: i + 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-03-26",
                clientInfo: { name: `client-${i}`, version: "1.0.0" },
                capabilities: {},
              },
            })
        )
      );

      // All should succeed
      for (const res of results) {
        expect(res.status).toBeLessThan(300);
        const body = extractResponse(res);
        expect(body.result).toBeDefined();
        expect(body.result.serverInfo).toBeDefined();
      }
    });
  });

  describe("Mcp-Session-Id header handling", () => {
    it("does NOT return 404 for an unknown session ID", async () => {
      const app = createStatelessApp();

      const res = await supertest(app)
        .post("/mcp")
        .set("Accept", "application/json, text/event-stream")
        .set("Mcp-Session-Id", "fabricated-session-id-does-not-exist")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        });

      // Must NOT be 404 -- the request should be processed normally
      expect(res.status).not.toBe(404);
      expect(res.status).toBeLessThan(300);
      const body = extractResponse(res);
      expect(body.result).toBeDefined();
      expect(body.result.tools).toBeDefined();
    });

    it("processes tools/call normally despite a stale session ID", async () => {
      const app = createStatelessApp();

      const res = await supertest(app)
        .post("/mcp")
        .set("Accept", "application/json, text/event-stream")
        .set("Mcp-Session-Id", "old-session-from-previous-deployment-12345")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo", arguments: { message: "with stale session" } },
        });

      expect(res.status).not.toBe(404);
      expect(res.status).toBeLessThan(300);
      const body = extractResponse(res);
      const text = body.result.content[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.echo).toBe("with stale session");
    });

    it("processes initialize normally with a stale session ID", async () => {
      const app = createStatelessApp();

      const res = await supertest(app)
        .post("/mcp")
        .set("Accept", "application/json, text/event-stream")
        .set("Mcp-Session-Id", "expired-uuid-from-scale-down")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            clientInfo: { name: "test-client", version: "1.0.0" },
            capabilities: {},
          },
        });

      expect(res.status).not.toBe(404);
      expect(res.status).toBeLessThan(300);
      const body = extractResponse(res);
      expect(body.result).toBeDefined();
    });
  });

  describe("stateless mode endpoint restrictions", () => {
    it("GET /mcp returns 405 (no SSE in stateless mode)", async () => {
      const app = createStatelessApp();

      const res = await supertest(app)
        .get("/mcp")
        .set("Accept", "text/event-stream");

      expect(res.status).toBe(405);
      expect(res.body.error.code).toBe(-32000);
      expect(res.body.error.message).toContain("stateless");
    });

    it("DELETE /mcp returns 405 (no sessions to terminate)", async () => {
      const app = createStatelessApp();

      const res = await supertest(app)
        .delete("/mcp")
        .set("Mcp-Session-Id", "any-id");

      expect(res.status).toBe(405);
      expect(res.body.error.code).toBe(-32000);
      expect(res.body.error.message).toContain("stateless");
    });
  });

  describe("isolation between requests", () => {
    it("each request is fully independent (no state leaks)", async () => {
      const app = createStatelessApp();

      // Send five tools/call requests in sequence -- each should succeed
      // independently without any shared state
      for (let i = 0; i < 5; i++) {
        const res = await supertest(app)
          .post("/mcp")
          .set("Accept", "application/json, text/event-stream")
          .send({
            jsonrpc: "2.0",
            id: i + 1,
            method: "tools/call",
            params: { name: "echo", arguments: { message: `request-${i}` } },
          });

        expect(res.status).toBeLessThan(300);
        const body = extractResponse(res);
        const text = body.result.content[0].text;
        const parsed = JSON.parse(text);
        expect(parsed.echo).toBe(`request-${i}`);
      }
    });
  });
});
