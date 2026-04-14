/**
 * MCP Azure Storage Server — main entry point.
 *
 * This Express application exposes a single `/mcp` endpoint that speaks
 * JSON-RPC 2.0 via the Model Context Protocol (MCP) Streamable HTTP transport.
 * It supports two modes:
 *
 *  • **Stateful** — MCP clients (Claude, RooCode, etc.) send an `initialize`
 *    request, which creates a persistent session with a UUID. Subsequent
 *    requests include the `Mcp-Session-Id` header to route to the same session.
 *
 *  • **Stateless** — HTTP clients (Postman, curl) skip `initialize` and send
 *    tool calls directly. A throwaway MCP server is created per request and
 *    cleaned up immediately.
 *
 * Security layers applied (in order):
 *  1. Helmet — sets security-related HTTP headers
 *  2. Rate limiter — per-IP request throttling on /mcp
 *  3. API key auth — validates X-API-Key or Bearer token
 *
 * @see {@link https://modelcontextprotocol.io/} MCP specification
 */

import "dotenv/config"; // Load .env file into process.env (local dev only; ignored in production)
import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { apiKeyAuth } from "./middleware/api-key.js";
import { registerBlobTools } from "./tools/blob-tools.js";
import { registerTableTools } from "./tools/table-tools.js";
import { registerQueueTools } from "./tools/queue-tools.js";
import { registerFileShareTools } from "./tools/fileshare-tools.js";
import { registerUtilityTools } from "./tools/utility-tools.js";
import { registerBlobResources } from "./resources/blob-resources.js";
import { registerFileShareResources } from "./resources/fileshare-resources.js";
import { registerQueueResources } from "./resources/queue-resources.js";
import { registerTableResources } from "./resources/table-resources.js";

// ── Express application ──────────────────────────────────────────────────────
const app = express();

// Trust the reverse proxy (Azure Container Apps / Azure Front Door).
// Required so that:
//  1. express-rate-limit uses the real client IP from X-Forwarded-For
//     (without this, all requests appear to come from the proxy IP)
//  2. req.ip / req.protocol reflect the original client connection
// Safe because Container Apps always terminates TLS and sets forwarded headers.
app.set("trust proxy", true);

// CORS — required for browser-based MCP clients (MCP Inspector, web chat, etc.)
// Enabled by default (dev-friendly). Set CORS_ENABLED=false in production if the
// server is only consumed by non-browser clients behind a reverse proxy.
const CORS_ENABLED = (process.env.CORS_ENABLED ?? "true").toLowerCase() !== "false";

if (CORS_ENABLED) {
  app.use(
    cors({
      origin: true, // reflect request origin (allow any)
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Accept",
        "Authorization",
        "X-API-Key",
        "Mcp-Session-Id",
      ],
      exposedHeaders: ["Mcp-Session-Id"],
      credentials: true,
      maxAge: 86400, // cache preflight for 24h
    })
  );
}

// Security headers (HSTS, X-Content-Type-Options, X-Frame-Options, etc.)
app.use(helmet());

// ── Keep-alive settings ──────────────────────────────────────────────────────
// Azure Container Apps has a ~240 s idle timeout on ingress connections. SSE
// streams that go idle (no tool calls) would be silently killed by the reverse
// proxy before reaching the Node process, causing clients to "lose connection"
// with no error in server logs. We send periodic SSE comments (": keepalive")
// to prevent this. The interval must be shorter than the proxy timeout.
const SSE_KEEPALIVE_INTERVAL_MS = parseInt(process.env.SSE_KEEPALIVE_INTERVAL_MS || "30000", 10); // 30s default

// ── Rate limiting ────────────────────────────────────────────────────────────
// Per-IP sliding window. Configurable via env vars; defaults to 300 req / 15 min.
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES || "15", 10) * 60 * 1000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "300", 10);

const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,  // Return RateLimit-* headers (draft-6)
  legacyHeaders: false,    // Disable X-RateLimit-* headers
  message: {
    jsonrpc: "2.0",
    error: { code: -32005, message: "Too many requests, please try again later." },
  },
});
app.use("/mcp", limiter);
app.use("/upload", limiter);

// Accept large JSON payloads (base64-encoded files can be tens of MB)
app.use(express.json({ limit: "50mb" }));

// ── MCP server factory ───────────────────────────────────────────────────────

/**
 * Create a fresh MCP server instance with all 36 tools and 12 resources.
 *
 * A new instance is created for each stateful session and each stateless
 * request. Tool and resource registrations read the shared singleton
 * StorageConfig and SDK clients from their respective modules, so this
 * is lightweight.
 *
 * @returns A fully-configured McpServer ready to connect to a transport.
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "azure-storage-mcp",
    version: "1.0.0",
  });

  // ── Tools (35 total) — actions that read or mutate storage ──
  registerBlobTools(server);
  registerTableTools(server);
  registerQueueTools(server);
  registerFileShareTools(server);
  registerUtilityTools(server);

  // ── Resources (12 total) — read-only, URI-addressable data ──
  registerBlobResources(server);
  registerFileShareResources(server);
  registerQueueResources(server);
  registerTableResources(server);

  return server;
}

// ── Session management for stateful mode ─────────────────────────────────────
//
// Stateful MCP sessions are stored in an in-memory Map keyed by session UUID.
// Each session holds a transport, MCP server, and a last-activity timestamp.
//
// Design notes:
//  • Sessions are evicted after SESSION_TTL_MS of inactivity (default: 30 min).
//  • A hard cap of MAX_SESSIONS prevents memory exhaustion from session floods.
//  • Sticky sessions in the Bicep infra route the same client to the same replica.
//  • Graceful shutdown (SIGTERM/SIGINT) closes all sessions before exiting.

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "100", 10);

/** Tracks an active stateful MCP session. */
interface ManagedSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** Unix timestamp (ms) of the last request on this session, used for TTL eviction. */
  lastActivity: number;
}

/** Active sessions keyed by UUID. */
const sessions = new Map<string, ManagedSession>();

// Periodic cleanup — runs every 5 minutes, evicts sessions idle > SESSION_TTL_MS
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

// ── API key auth on /mcp ─────────────────────────────────────────────────────
// All /mcp routes require a valid API key. See middleware/api-key.ts.
app.use("/mcp", apiKeyAuth);

// ══════════════════════════════════════════════════════════════════════════════
// POST /mcp — Main MCP request handler
//
// Request routing logic (in priority order):
//  1. If Mcp-Session-Id header matches an existing session → stateful dispatch
//  2. If the body contains an "initialize" method → create a new stateful session
//  3. Otherwise → stateless one-shot (creates + destroys a server per request)
// ══════════════════════════════════════════════════════════════════════════════
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

  // ─── Reject stale/invalid session IDs ───
  // If the client sends an Mcp-Session-Id that doesn't match any active session
  // (e.g. after a scale-down, redeployment, or TTL expiry), return a clear error
  // instead of silently falling through to stateless mode.
  if (sessionId) {
    res.status(404).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: `Session not found: ${sessionId}. The session may have expired or the server may have restarted. Send a new initialize request to create a fresh session.`,
      },
    });
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

// ══════════════════════════════════════════════════════════════════════════════
// GET /mcp — Server-Sent Events (SSE) stream for stateful sessions
//
// MCP clients may open a GET connection to receive server-initiated
// notifications (e.g. progress updates). Requires a valid Mcp-Session-Id.
// ══════════════════════════════════════════════════════════════════════════════
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

  // ── SSE keepalive heartbeat ──
  // Azure Container Apps / Front Door closes idle connections after ~240 seconds.
  // We send periodic SSE comment lines (": keepalive\n\n") which are ignored by
  // SSE parsers but keep the TCP connection alive through the reverse proxy.
  // The timer is cleared when the response closes (client disconnect or session end).
  const keepaliveTimer = setInterval(() => {
    if (!res.writableEnded) {
      try {
        res.write(": keepalive\n\n");
        session.lastActivity = Date.now(); // refresh TTL on keepalive too
      } catch {
        clearInterval(keepaliveTimer);
      }
    } else {
      clearInterval(keepaliveTimer);
    }
  }, SSE_KEEPALIVE_INTERVAL_MS);

  res.on("close", () => clearInterval(keepaliveTimer));

  try {
    await session.transport.handleRequest(req, res);
  } catch (error: unknown) {
    clearInterval(keepaliveTimer);
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

// ══════════════════════════════════════════════════════════════════════════════
// DELETE /mcp — Explicitly close a stateful session
//
// MCP clients should call this when they're done to free server resources
// immediately, rather than waiting for the TTL to expire.
// ══════════════════════════════════════════════════════════════════════════════
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

// ── Health check (no auth required) ──────────────────────────────────────────
// Used by Container Apps liveness/readiness probes (see infra/main.bicep).
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "healthy" });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /upload — Direct file upload via multipart form-data
//
// This REST endpoint bypasses the MCP JSON-RPC transport entirely, allowing
// any HTTP client (curl, Python, browser, CI/CD) to upload files of any size
// directly to Azure Blob Storage without base64 encoding.
//
// This solves the "large file" problem: MCP is JSON-RPC, so binary content
// must be base64-encoded in JSON — impractical for multi-MB files when the
// LLM context window can't hold the encoded string. This endpoint accepts
// standard multipart/form-data uploads instead.
//
// Usage:
//   curl -X POST https://<host>/upload \
//     -H "X-API-Key: <key>" \
//     -F "file=@./report.pdf" \
//     -F "containerName=my-container" \
//     -F "blobName=reports/2024/report.pdf"
//
// Security: Protected by the same API key middleware as /mcp.
// ══════════════════════════════════════════════════════════════════════════════

// Multer stores uploaded files in memory (Buffer). The 100MB limit matches
// Azure Container Apps' default request body limit. For very large files,
// consider using blob-get-container-sas to generate a write SAS URL and
// uploading directly to Azure Storage from the client.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

app.post("/upload", apiKeyAuth, upload.single("file"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file provided. Send a multipart form with a 'file' field." });
      return;
    }

    const containerName = req.body.containerName;
    if (!containerName) {
      res.status(400).json({ error: "Missing required field: containerName" });
      return;
    }

    // Use provided blobName, or fall back to the original filename
    const blobName = req.body.blobName || file.originalname;
    if (!blobName) {
      res.status(400).json({ error: "Missing required field: blobName (or upload a file with a filename)" });
      return;
    }

    // Parse optional metadata from JSON string
    let metadata: Record<string, string> | undefined;
    if (req.body.metadata) {
      try {
        metadata = JSON.parse(req.body.metadata);
      } catch {
        res.status(400).json({ error: "Invalid metadata JSON. Provide a JSON object string, e.g. '{\"author\":\"Alice\"}'" });
        return;
      }
    }

    // Lazy-load storage config and create client (same pattern as blob-tools.ts)
    const { getStorageConfig } = await import("./config.js");
    const config = getStorageConfig();
    const { BlobServiceClient, StorageSharedKeyCredential } = await import("@azure/storage-blob");

    const credential = new StorageSharedKeyCredential(config.accountName, config.accountKey);
    const blobServiceUrl = config.blobServiceUrl || `https://${config.accountName}.blob.core.windows.net`;
    const blobServiceClient = new BlobServiceClient(blobServiceUrl, credential);

    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Use the MIME type from multer (which reads the Content-Type header from the
    // multipart part), or fall back to octet-stream
    const contentType = file.mimetype || "application/octet-stream";

    await blockBlobClient.uploadData(file.buffer, {
      blobHTTPHeaders: { blobContentType: contentType },
    });

    if (metadata && Object.keys(metadata).length > 0) {
      await blockBlobClient.setMetadata(metadata);
    }

    res.status(200).json({
      success: true,
      blobName,
      containerName,
      contentType,
      size: file.buffer.length,
      metadataSet: metadata ? Object.keys(metadata).length : 0,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Upload failed";
    console.error("Upload error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  }
});

// ── Start HTTP server ────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const httpServer = app.listen(PORT, () => {
  console.log(`\n🚀 MCP Azure Storage Server v1.0.0`);
  console.log(`   MCP endpoint : http://localhost:${PORT}/mcp`);
  console.log(`   Upload       : http://localhost:${PORT}/upload`);
  console.log(`   Health check : http://localhost:${PORT}/health`);
  console.log(`   Modes        : Stateful (session) + Stateless (one-shot)`);
  console.log(
    `   API key auth : ${process.env.MCP_API_KEY ? "✅ ENABLED" : "⚠️  DISABLED (set MCP_API_KEY)"}`
  );
  console.log(`   CORS         : ${CORS_ENABLED ? "✅ ENABLED" : "❌ DISABLED"}`);
  console.log(`   Rate limit   : ${RATE_LIMIT_MAX} req / ${RATE_LIMIT_WINDOW_MS / 60000} min per IP`);
  console.log(`   Session TTL  : ${SESSION_TTL_MS / 60000} minutes`);
  console.log(`   Max sessions : ${MAX_SESSIONS}`);
  console.log(`   SSE keepalive: ${SSE_KEEPALIVE_INTERVAL_MS / 1000}s`);
  console.log(`   JSON limit   : 50mb`);
  console.log(`   Upload limit : 100mb\n`);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Container Apps sends SIGTERM during scale-down or redeployment.
// This handler drains active sessions, stops accepting new connections,
// and force-exits after 10 seconds if connections don't close cleanly.

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
