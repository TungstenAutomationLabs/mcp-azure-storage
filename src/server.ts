import "dotenv/config";
import express, { Request, Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { apiKeyAuth } from "./middleware/api-key.js";
import { registerBlobTools } from "./tools/blob-tools.js";
import { registerTableTools } from "./tools/table-tools.js";
import { registerQueueTools } from "./tools/queue-tools.js";
import { registerFileShareTools } from "./tools/fileshare-tools.js";
import { registerUtilityTools } from "./tools/utility-tools.js";

const app = express();

// ── Security headers ──
app.use(helmet());

// ── Rate limiting ──
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES || "15", 10) * 60 * 1000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "300", 10);

const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    jsonrpc: "2.0",
    error: { code: -32005, message: "Too many requests, please try again later." },
  },
});
app.use("/mcp", limiter);

app.use(express.json({ limit: "50mb" })); // Large payloads for base64 file content

/**
 * Create a fresh MCP server instance with all tools registered.
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "azure-storage-mcp",
    version: "1.0.0",
  });

  registerBlobTools(server);
  registerTableTools(server);
  registerQueueTools(server);
  registerFileShareTools(server);
  registerUtilityTools(server);

  return server;
}

// ── Session management for stateful mode ──
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "100", 10);

interface ManagedSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

const sessions = new Map<string, ManagedSession>();

// ── Session cleanup interval — evict stale sessions every 5 minutes ──
const sessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      console.log(`Session ${sid} expired after ${SESSION_TTL_MS / 60000}min inactivity — cleaning up`);
      try { session.server.close(); } catch { /* ignore */ }
      sessions.delete(sid);
    }
  }
}, 5 * 60 * 1000);

// ── API key auth on /mcp ──
app.use("/mcp", apiKeyAuth);

// ── POST /mcp — handles all MCP requests ──
app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // ─── Route to existing session ───
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastActivity = Date.now(); // refresh TTL
    try {
      await session.transport.handleRequest(req, res, req.body);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Internal error";
      console.error("MCP session request error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message },
        });
      }
    }
    return;
  }

  // ─── Detect if this is an initialize request ───
  const body = req.body;
  const isInitialize =
    body?.method === "initialize" ||
    (Array.isArray(body) && body.some((m: { method?: string }) => m.method === "initialize"));

  if (isInitialize) {
    // ── Guard: reject if we've hit the session cap ──
    if (sessions.size >= MAX_SESSIONS) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: {
          code: -32005,
          message: `Server at session capacity (${MAX_SESSIONS}). Try again later.`,
        },
      });
      return;
    }

    // ── Stateful mode: create a session for MCP clients (Postman MCP, Claude, etc.) ──
    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && sessions.has(sid)) {
        sessions.delete(sid);
        console.log(`Session ${sid} closed and cleaned up`);
      }
    };

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);

      const sid = transport.sessionId;
      if (sid) {
        sessions.set(sid, { transport, server: mcpServer, lastActivity: Date.now() });
        console.log(`New session created: ${sid}`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Internal error";
      console.error("MCP initialize error:", error);
      try { await mcpServer.close(); } catch { /* ignore */ }
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message },
        });
      }
    }
    return;
  }

  // ─── Stateless mode: one-shot request (no session needed) ───
  // This handles standalone tool calls, tools/list, etc. via HTTP POST
  // without requiring a prior initialize — convenient for Postman HTTP testing
  const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — returns plain JSON
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal error";
    console.error("MCP stateless request error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message },
      });
    }
  } finally {
    // Clean up one-shot resources to prevent connection/memory leaks
    try { await mcpServer.close(); } catch { /* ignore */ }
  }
});

// ── GET /mcp — SSE stream for server-initiated notifications (stateful) ──
app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Invalid or missing Mcp-Session-Id. Send initialize via POST first.",
      },
    });
    return;
  }

  const session = sessions.get(sessionId)!;
  session.lastActivity = Date.now(); // refresh TTL
  try {
    await session.transport.handleRequest(req, res);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal error";
    console.error("SSE stream error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message },
      });
    }
  }
});

// ── DELETE /mcp — close a session ──
app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Invalid or missing Mcp-Session-Id.",
      },
    });
    return;
  }

  const session = sessions.get(sessionId)!;
  try {
    await session.transport.handleRequest(req, res);
    await session.server.close();
    sessions.delete(sessionId);
    console.log(`Session ${sessionId} terminated by client`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal error";
    console.error("Session close error:", error);
    sessions.delete(sessionId);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message },
      });
    }
  }
});

// ── Health (no auth) ──
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "healthy" });
});

const PORT = parseInt(process.env.PORT || "3000", 10);
const httpServer = app.listen(PORT, () => {
  console.log(`\n🚀 MCP Azure Storage Server v1.0.0`);
  console.log(`   MCP endpoint : http://localhost:${PORT}/mcp`);
  console.log(`   Health check : http://localhost:${PORT}/health`);
  console.log(`   Modes        : Stateful (session) + Stateless (one-shot)`);
  console.log(
    `   API key auth : ${process.env.MCP_API_KEY ? "✅ ENABLED" : "⚠️  DISABLED (set MCP_API_KEY)"}`
  );
  console.log(`   Rate limit   : ${RATE_LIMIT_MAX} req / ${RATE_LIMIT_WINDOW_MS / 60000} min per IP`);
  console.log(`   Session TTL  : ${SESSION_TTL_MS / 60000} minutes`);
  console.log(`   Max sessions : ${MAX_SESSIONS}`);
  console.log(`   JSON limit   : 50mb\n`);
});

// ── Graceful shutdown — close sessions & stop accepting requests ──
function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down gracefully…`);
  clearInterval(sessionCleanupTimer);

  // Close all active MCP sessions
  for (const [sid, session] of sessions) {
    try { session.server.close(); } catch { /* ignore */ }
    sessions.delete(sid);
  }

  httpServer.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });

  // Force exit after 10s if connections don't drain
  setTimeout(() => {
    console.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
