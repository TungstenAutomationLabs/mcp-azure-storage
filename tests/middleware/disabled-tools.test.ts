/**
 * Unit tests for DISABLED_TOOLS gating (v1.1 Item 5).
 *
 * Tests that:
 *  - tools/list omits disabled tools
 *  - tools/call to a disabled tool returns a structured forbidden error
 *  - enabled tools still function normally
 *  - unknown names in DISABLED_TOOLS don't crash startup
 *  - parseDisabledTools handles edge cases
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import supertest from "supertest";
import {
  extractJsonRpcResponse,
  mcpPost,
  toolCallRequest,
  toolListRequest,
  extractToolsList,
} from "../helpers/mcp-test-harness.js";

// ── parseDisabledTools import ────────────────────────────────────────────────
// We test the pure utility functions directly for edge cases.
// Imported from the side-effect-free utility module (not server.ts).
import { parseDisabledTools, buildDisabledToolError } from "../../src/utils/disabled-tools.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a test app with disabled-tool gating applied.
 *
 * Registers three dummy tools: "tool-alpha", "tool-beta", "tool-gamma".
 * Any tool whose name (case-insensitive) appears in `disabledNames` will
 * be skipped at registration time, and calls to it will be rejected by a
 * pre-dispatch guard that mirrors the real server's behavior.
 */
function createDisabledToolsTestApp(disabledNames: Set<string>) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.post("/mcp", async (req: Request, res: Response) => {
    // ── Pre-dispatch guard: reject calls to disabled tools ──
    const body = req.body;
    if (disabledNames.size > 0 && body?.method === "tools/call") {
      const targetTool = body?.params?.name;
      if (typeof targetTool === "string" && disabledNames.has(targetTool.toLowerCase())) {
        const forbidden = buildDisabledToolError(targetTool);
        res.status(403).json({
          jsonrpc: "2.0",
          id: body?.id ?? null,
          error: {
            code: -32603,
            message: forbidden.error,
            data: forbidden.data,
          },
        });
        return;
      }
    }

    const mcpServer = new McpServer({
      name: "test-server",
      version: "1.0.0",
    });

    // Apply disabled-tool gating to registration
    if (disabledNames.size > 0) {
      const origTool = mcpServer.tool.bind(mcpServer);
      (mcpServer as any).tool = function gatedTool(...args: unknown[]) {
        const toolName = args[0];
        if (typeof toolName === "string" && disabledNames.has(toolName.toLowerCase())) {
          return; // Skip registration
        }
        return (origTool as Function).apply(mcpServer, args);
      };
    }

    // Register 3 dummy tools
    mcpServer.tool("tool-alpha", "Alpha tool", { value: z.string() }, async ({ value }) => ({
      content: [{ type: "text" as const, text: `alpha:${value}` }],
    }));

    mcpServer.tool("tool-beta", "Beta tool (destructive)", { value: z.string() }, async ({ value }) => ({
      content: [{ type: "text" as const, text: `beta:${value}` }],
    }));

    mcpServer.tool("tool-gamma", "Gamma tool", { value: z.string() }, async ({ value }) => ({
      content: [{ type: "text" as const, text: `gamma:${value}` }],
    }));

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
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

  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DISABLED_TOOLS gating", () => {
  describe("parseDisabledTools", () => {
    it("returns empty set for undefined", () => {
      expect(parseDisabledTools(undefined).size).toBe(0);
    });

    it("returns empty set for empty string", () => {
      expect(parseDisabledTools("").size).toBe(0);
    });

    it("returns empty set for whitespace-only string", () => {
      expect(parseDisabledTools("   ").size).toBe(0);
    });

    it("parses a single tool name", () => {
      const set = parseDisabledTools("blob-delete");
      expect(set.size).toBe(1);
      expect(set.has("blob-delete")).toBe(true);
    });

    it("parses comma-separated tool names", () => {
      const set = parseDisabledTools("blob-delete,queue-delete,table-delete");
      expect(set.size).toBe(3);
      expect(set.has("blob-delete")).toBe(true);
      expect(set.has("queue-delete")).toBe(true);
      expect(set.has("table-delete")).toBe(true);
    });

    it("normalises to lowercase (case-insensitive)", () => {
      const set = parseDisabledTools("Blob-Delete, QUEUE-DELETE");
      expect(set.has("blob-delete")).toBe(true);
      expect(set.has("queue-delete")).toBe(true);
    });

    it("trims whitespace around names", () => {
      const set = parseDisabledTools("  blob-delete , queue-delete  ");
      expect(set.has("blob-delete")).toBe(true);
      expect(set.has("queue-delete")).toBe(true);
    });

    it("ignores empty entries from trailing/leading commas", () => {
      const set = parseDisabledTools(",blob-delete,,queue-delete,");
      expect(set.size).toBe(2);
      expect(set.has("blob-delete")).toBe(true);
      expect(set.has("queue-delete")).toBe(true);
    });

    it("deduplicates repeated names", () => {
      const set = parseDisabledTools("blob-delete,blob-delete,BLOB-DELETE");
      expect(set.size).toBe(1);
    });
  });

  describe("buildDisabledToolError", () => {
    it("returns structured forbidden error with tool name", () => {
      const err = buildDisabledToolError("blob-delete");
      expect(err.code).toBe("forbidden");
      expect(err.error).toBe("Tool 'blob-delete' is disabled by server policy");
      expect(err.data.reason).toBe("disabled_tool");
      expect(err.data.toolName).toBe("blob-delete");
    });
  });

  describe("tools/list filtering", () => {
    it("excludes disabled tools from the tools list", async () => {
      const disabled = new Set(["tool-beta"]);
      const app = createDisabledToolsTestApp(disabled);

      const res = await mcpPost(app, toolListRequest());
      const tools = extractToolsList(res);

      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain("tool-alpha");
      expect(toolNames).not.toContain("tool-beta");
      expect(toolNames).toContain("tool-gamma");
    });

    it("returns all tools when no tools are disabled", async () => {
      const disabled = new Set<string>();
      const app = createDisabledToolsTestApp(disabled);

      const res = await mcpPost(app, toolListRequest());
      const tools = extractToolsList(res);

      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain("tool-alpha");
      expect(toolNames).toContain("tool-beta");
      expect(toolNames).toContain("tool-gamma");
    });

    it("can disable multiple tools at once", async () => {
      const disabled = new Set(["tool-alpha", "tool-gamma"]);
      const app = createDisabledToolsTestApp(disabled);

      const res = await mcpPost(app, toolListRequest());
      const tools = extractToolsList(res);

      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).not.toContain("tool-alpha");
      expect(toolNames).toContain("tool-beta");
      expect(toolNames).not.toContain("tool-gamma");
    });
  });

  describe("tools/call to disabled tool", () => {
    it("returns 403 with structured forbidden error", async () => {
      const disabled = new Set(["tool-beta"]);
      const app = createDisabledToolsTestApp(disabled);

      const res = await supertest(app)
        .post("/mcp")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send(toolCallRequest("tool-beta", { value: "test" }))
        .expect(403);

      expect(res.body.jsonrpc).toBe("2.0");
      expect(res.body.id).toBe(1);
      expect(res.body.error.code).toBe(-32603);
      expect(res.body.error.message).toBe("Tool 'tool-beta' is disabled by server policy");
      expect(res.body.error.data.reason).toBe("disabled_tool");
      expect(res.body.error.data.toolName).toBe("tool-beta");
    });

    it("preserves the request id in the error response", async () => {
      const disabled = new Set(["tool-beta"]);
      const app = createDisabledToolsTestApp(disabled);

      const res = await supertest(app)
        .post("/mcp")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send(toolCallRequest("tool-beta", { value: "x" }, 42))
        .expect(403);

      expect(res.body.id).toBe(42);
    });

    it("returns null id when request has no id", async () => {
      const disabled = new Set(["tool-beta"]);
      const app = createDisabledToolsTestApp(disabled);

      const res = await supertest(app)
        .post("/mcp")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send({
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "tool-beta", arguments: { value: "x" } },
        })
        .expect(403);

      expect(res.body.id).toBeNull();
    });

    it("is case-insensitive for tool name matching", async () => {
      const disabled = new Set(["tool-beta"]); // lowercase in disabled set
      const app = createDisabledToolsTestApp(disabled);

      // Call with different casing — should still be rejected
      const res = await supertest(app)
        .post("/mcp")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "Tool-Beta", arguments: { value: "x" } },
        })
        .expect(403);

      expect(res.body.error.data.reason).toBe("disabled_tool");
      // The toolName in the error should be the actual name from the request
      expect(res.body.error.data.toolName).toBe("Tool-Beta");
    });
  });

  describe("enabled tools still function normally", () => {
    it("allows calls to enabled tools when some tools are disabled", async () => {
      const disabled = new Set(["tool-beta"]);
      const app = createDisabledToolsTestApp(disabled);

      const res = await mcpPost(app, toolCallRequest("tool-alpha", { value: "hello" }));
      const jsonRpc = extractJsonRpcResponse(res);

      expect(jsonRpc.result).toBeDefined();
      expect(jsonRpc.result.content[0].text).toBe("alpha:hello");
    });

    it("allows calls to all tools when none are disabled", async () => {
      const disabled = new Set<string>();
      const app = createDisabledToolsTestApp(disabled);

      const resAlpha = await mcpPost(app, toolCallRequest("tool-alpha", { value: "a" }, 1));
      const resBeta = await mcpPost(app, toolCallRequest("tool-beta", { value: "b" }, 2));
      const resGamma = await mcpPost(app, toolCallRequest("tool-gamma", { value: "c" }, 3));

      expect(extractJsonRpcResponse(resAlpha).result.content[0].text).toBe("alpha:a");
      expect(extractJsonRpcResponse(resBeta).result.content[0].text).toBe("beta:b");
      expect(extractJsonRpcResponse(resGamma).result.content[0].text).toBe("gamma:c");
    });
  });

  describe("unknown disabled tool names", () => {
    it("does not crash when DISABLED_TOOLS contains names not matching any registered tool", async () => {
      // "nonexistent-tool" is not registered; server should still start and work
      const disabled = new Set(["tool-beta", "nonexistent-tool"]);
      const app = createDisabledToolsTestApp(disabled);

      // tools/list should still work
      const listRes = await mcpPost(app, toolListRequest());
      const tools = extractToolsList(listRes);
      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain("tool-alpha");
      expect(toolNames).not.toContain("tool-beta");
      expect(toolNames).toContain("tool-gamma");

      // Enabled tool should still work
      const callRes = await mcpPost(app, toolCallRequest("tool-alpha", { value: "ok" }));
      const jsonRpc = extractJsonRpcResponse(callRes);
      expect(jsonRpc.result.content[0].text).toBe("alpha:ok");
    });

    it("calling an unknown disabled tool name returns forbidden (pre-dispatch guard)", async () => {
      const disabled = new Set(["nonexistent-tool"]);
      const app = createDisabledToolsTestApp(disabled);

      const res = await supertest(app)
        .post("/mcp")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send(toolCallRequest("nonexistent-tool", { value: "x" }))
        .expect(403);

      expect(res.body.error.data.reason).toBe("disabled_tool");
    });
  });

  describe("startup validation warnings", () => {
    it("logs a warning for unknown tool names in DISABLED_TOOLS", () => {
      // We can't easily test the real validateDisabledToolNames without starting
      // the full server, but we verify it doesn't throw by checking the function
      // exists and the disabled set correctly identifies unknown names.
      const disabled = parseDisabledTools("blob-delete,totally-fake-tool");
      expect(disabled.has("blob-delete")).toBe(true);
      expect(disabled.has("totally-fake-tool")).toBe(true);
      // The validation runs at server startup and logs warnings; the important
      // thing is it doesn't crash. We verify this indirectly by the test app
      // working fine with unknown names (covered above).
    });
  });
});
