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
 *  2. API key auth — validates X-API-Key or Bearer token
 *  3. Rate limiter — per-identity request throttling (API-key hash or IP)
 *
 * @see {@link https://modelcontextprotocol.io/} MCP specification
 */

import "dotenv/config"; // Load .env file into process.env (local dev only; ignored in production)
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer, { MulterError } from "multer";
import { createReadStream } from "fs";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import {
  BlobServiceClient,
  ContainerSASPermissions,
  generateBlobSASQueryParameters,
  SASProtocol,
} from "@azure/storage-blob";
import { apiKeyAuth } from "./middleware/api-key.js";
import { getStorageConfig, getCredential, getSharedKeyCredential, hasSharedKey } from "./config.js";
import { wrapToolErrorHandler } from "./utils/errors.js";
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
// TRUST_PROXY_HOPS controls how many proxy hops to trust. Default 1 is correct
// for a single reverse proxy (e.g. Azure Container Apps ingress). Set to 2 if
// there is an additional proxy layer (e.g. Azure Front Door + Container Apps).
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));

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
// Separate budgets for /mcp (MCP JSON-RPC) and /upload (multipart REST).
// New env vars override the legacy RATE_LIMIT_WINDOW_MINUTES / RATE_LIMIT_MAX_REQUESTS.

// Legacy fallback values (backward-compatible)
const legacyWindowSeconds = parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES || "15", 10) * 60;
const legacyMax = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "300", 10);

// New-style env vars with defaults; fall back to legacy when unset
const RATE_LIMIT_WINDOW_SECONDS = process.env.RATE_LIMIT_WINDOW_SECONDS
  ? parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS, 10)
  : legacyWindowSeconds;
const RATE_LIMIT_MCP_MAX = process.env.RATE_LIMIT_MCP_MAX
  ? parseInt(process.env.RATE_LIMIT_MCP_MAX, 10)
  : (process.env.RATE_LIMIT_MAX_REQUESTS ? legacyMax : 3000);
const RATE_LIMIT_UPLOAD_MAX = process.env.RATE_LIMIT_UPLOAD_MAX
  ? parseInt(process.env.RATE_LIMIT_UPLOAD_MAX, 10)
  : (process.env.RATE_LIMIT_MAX_REQUESTS ? legacyMax : 600);

// Session capacity retry hint (seconds)
const SESSION_RETRY_AFTER_SECONDS = parseInt(process.env.SESSION_RETRY_AFTER_SECONDS || "30", 10);

/**
 * Derive a rate-limit identity key from the request.
 *
 * - If the request carries an API key (X-API-Key or Bearer) and it matches
 *   the configured MCP_API_KEY, key on SHA-256(apiKey) so each legitimate
 *   key holder gets their own budget.
 * - If MCP_API_KEY is not configured (auth disabled), any presented API key
 *   is hashed so different keys still get separate budgets.
 * - Otherwise, key on the resolved client IP (respects trust proxy hops).
 *
 * @returns `{ key, isApiKey }` — key is the limiter identity string,
 *          isApiKey is true when the key derives from a valid API key.
 */
export function getRateLimitKey(req: Request): { key: string; isApiKey: boolean } {
  const providedKey =
    (req.headers["x-api-key"] as string | undefined) ||
    extractBearerTokenForRateLimit(req.headers.authorization);

  if (providedKey) {
    const configuredKey = process.env.MCP_API_KEY;
    // If auth is disabled (no MCP_API_KEY) or the key matches, key on the hash
    if (!configuredKey || timingSafeEqualForRateLimit(configuredKey, providedKey)) {
      const hash = crypto.createHash("sha256").update(providedKey).digest("hex");
      return { key: `apikey:${hash}`, isApiKey: true };
    }
  }

  // Fallback: key on client IP
  return { key: `ip:${req.ip || "unknown"}`, isApiKey: false };
}

/** Extract Bearer token from Authorization header (rate-limit helper). */
function extractBearerTokenForRateLimit(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : undefined;
}

/** Constant-time string comparison (rate-limit helper, mirrors api-key.ts). */
function timingSafeEqualForRateLimit(a: string, b: string): boolean {
  if (a.length !== b.length) {
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── MCP rate limiter (/mcp JSON-RPC) ─────────────────────────────────────────
const mcpLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_SECONDS * 1000,
  max: RATE_LIMIT_MCP_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => getRateLimitKey(req).key,
  handler: (req: Request, res: Response) => {
    const retryAfterSeconds = RATE_LIMIT_WINDOW_SECONDS;
    res.set("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: {
        code: -32005,
        message: "Too many requests, please try again later.",
        data: { reason: "rate_limited", retryAfterSeconds },
      },
    });
  },
});

// ── Upload rate limiter (/upload REST) ───────────────────────────────────────
const uploadLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_SECONDS * 1000,
  max: RATE_LIMIT_UPLOAD_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => getRateLimitKey(req).key,
  handler: (_req: Request, res: Response) => {
    const retryAfterSeconds = RATE_LIMIT_WINDOW_SECONDS;
    res.set("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      error: "Too many requests, please try again later.",
      code: "rate_limited",
      retryAfterSeconds,
    });
  },
});

// Accept large JSON payloads (base64-encoded files can be tens of MB).
// Files beyond this limit should use the multipart /upload endpoint instead.
app.use(express.json({ limit: "50mb" }));

// ── JSON body parser error handler ───────────────────────────────────────────
// When express.json() rejects a request (e.g. PayloadTooLargeError), Express
// emits a bare 500. This middleware intercepts those errors and returns
// structured JSON with the correct HTTP status so callers can choose an
// alternative path (multipart upload, SAS URL, etc.) instead of discovering
// the limit by failing.
app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err.type === "entity.too.large") {
    res.status(413).json({
      error: `Request body too large: ${err.message}`,
      suggestion: "For large files, use the multipart POST /upload endpoint instead of base64 encoding. " +
        "For files beyond the upload limit, use 'blob-get-sas-url' to get a direct write URL.",
      maxJsonBodyMB: 50,
    });
    return;
  }
  // Pass other errors through
  next(err);
});

// ── MCP server factory ───────────────────────────────────────────────────────

/**
 * Create a fresh MCP server instance with all 37 tools and 12 resources.
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

  // ── Structured error wrapper ───────────────────────────────────────────
  // Patches server.tool() so every handler is wrapped in try/catch.
  // On error the wrapper converts the exception to a StructuredError JSON
  // payload and re-throws, so the MCP SDK returns isError: true with the
  // JSON string as the text content. Must be called before tool registration.
  wrapToolErrorHandler(server);

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
// Auth runs BEFORE rate limiting so that valid keys are recognized for
// per-key rate-limit keying (SHA-256 of API key instead of IP).
app.use("/mcp", apiKeyAuth);
app.use("/mcp", mcpLimiter);

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
          data: { reason: "session_capacity", retryAfterSeconds: SESSION_RETRY_AFTER_SECONDS },
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
// any HTTP client (curl, Python, browser, CI/CD) to upload files directly
// to Azure Blob Storage without base64 encoding.
//
// Files are written to a temp directory on disk (not buffered in RAM), then
// streamed to Azure Blob Storage via uploadStream. This avoids OOM errors
// for large files.
//
// If Content-Length exceeds MAX_UPLOAD_SIZE_BYTES, the request is rejected
// early with a 413 response that includes a pre-signed write SAS URL so
// the caller can upload directly to Azure Storage, bypassing this server.
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

// ── Upload size limit ────────────────────────────────────────────────────────
// Configurable via MAX_UPLOAD_SIZE_MB env var (default: 500 MB).
// Files larger than this should be uploaded directly to Azure using a write
// SAS URL (returned in the 413 error response).
const MAX_UPLOAD_SIZE_MB = parseInt(process.env.MAX_UPLOAD_SIZE_MB || "500", 10);
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

// ── Singleton BlobServiceClient for /upload ──────────────────────────────────
// Reuses the same HTTP connection pool across all upload requests, matching
// the pattern in blob-tools.ts. Lazy-initialised on first use to avoid
// crashing at import time if env vars are not yet set.
let _uploadBlobServiceClient: BlobServiceClient | null = null;

async function getUploadBlobServiceClient(): Promise<BlobServiceClient> {
  if (_uploadBlobServiceClient) return _uploadBlobServiceClient;

  const config = getStorageConfig();
  const credential = await getCredential();
  const blobServiceUrl = config.blobServiceUrl || `https://${config.accountName}.blob.core.windows.net`;
  _uploadBlobServiceClient = new BlobServiceClient(blobServiceUrl, credential);
  return _uploadBlobServiceClient;
}

// Multer writes uploaded files to a temp directory on disk instead of
// buffering in memory. This prevents OOM for large files. Temp files are
// cleaned up in the request handler's finally block.
const upload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, file, cb) => {
      // Unique filename to avoid collisions from concurrent uploads
      const unique = `mcp-upload-${Date.now()}-${randomUUID()}`;
      const ext = path.extname(file.originalname || "");
      cb(null, `${unique}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
});

/**
 * Wraps Multer's upload.single() middleware so that MulterErrors
 * (especially LIMIT_FILE_SIZE) are caught and returned as structured
 * JSON with the correct HTTP status code (413 or 400) instead of
 * falling through to Express's default 500 handler.
 *
 * Without this wrapper, Multer calls next(err) which bypasses the
 * route handler's try/catch entirely.
 */
function multerUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();

    // Clean up the temp file if Multer already wrote part of it
    if (req.file?.path) {
      unlink(req.file.path).catch(() => { /* best-effort */ });
    }

    if (err instanceof MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        const limitMB = MAX_UPLOAD_SIZE_MB;
        res.status(413).json({
          error: `File too large: exceeds the ${limitMB} MB upload limit.`,
          multerCode: err.code,
          suggestion: "Upload directly to Azure Blob Storage using a write SAS URL. " +
            "Call 'blob-get-sas-url' or 'blob-get-container-sas' with write permissions to generate one.",
          maxUploadSizeMB: limitMB,
        });
        return;
      }
      // Other Multer errors (LIMIT_UNEXPECTED_FILE, etc.)
      res.status(400).json({
        error: `Upload rejected: ${err.message}`,
        multerCode: err.code,
      });
      return;
    }

    // Non-Multer error (disk full, stream error, etc.)
    const message = err instanceof Error ? err.message : "Upload failed during file reception";
    console.error("Multer error:", err);
    res.status(500).json({ error: message });
  });
}

/**
 * Content-Length pre-check middleware.
 *
 * If the Content-Length header indicates a file larger than the configured
 * limit, reject immediately with 413 and a helpful JSON body. For requests
 * that include a containerName and blobName in the query string or are
 * parseable, we include a pre-signed write SAS URL so the caller can upload
 * directly to Azure Storage instead.
 *
 * This fires BEFORE Multer starts consuming the request body, so the
 * connection is closed cleanly — no partial reads, no hung streams.
 */
function uploadSizeGuard(req: Request, res: Response, next: NextFunction): void {
  const contentLength = parseInt(req.headers["content-length"] || "0", 10);

  if (contentLength > MAX_UPLOAD_SIZE_BYTES) {
    const sizeMB = (contentLength / (1024 * 1024)).toFixed(1);
    const limitMB = MAX_UPLOAD_SIZE_MB;

    // Best-effort: generate a write SAS URL if we can parse enough from the request
    // to know the container. Query params are available before body parsing.
    let directUploadUrl: string | undefined;
    const containerName = req.query.containerName as string | undefined;
    const blobName = req.query.blobName as string | undefined;

    if (containerName && blobName && hasSharedKey()) {
      try {
        const config = getStorageConfig();
        const credential = getSharedKeyCredential();
        const expiresOn = new Date();
        expiresOn.setHours(expiresOn.getHours() + 1);

        const sasToken = generateBlobSASQueryParameters(
          {
            containerName,
            permissions: ContainerSASPermissions.parse("rwl"),
            startsOn: new Date(),
            expiresOn,
            protocol: SASProtocol.HttpsAndHttp,
          },
          credential
        ).toString();

        directUploadUrl = `https://${config.accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`;
      } catch {
        // Config not available or no shared key — skip the SAS URL
      }
    }

    res.status(413).json({
      error: `File too large: ${sizeMB} MB exceeds the ${limitMB} MB upload limit.`,
      suggestion: "Upload directly to Azure Blob Storage using the SAS URL below, or use 'blob-get-container-sas' with write permissions to generate one.",
      ...(directUploadUrl && {
        directUploadUrl,
        directUploadMethod: "PUT",
        directUploadHeaders: { "x-ms-blob-type": "BlockBlob" },
        expiresInHours: 1,
      }),
    });
    return;
  }

  next();
}

app.post("/upload", apiKeyAuth, uploadLimiter, uploadSizeGuard, multerUpload, async (req: Request, res: Response) => {
  let tempFilePath: string | undefined;

  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file provided. Send a multipart form with a 'file' field." });
      return;
    }

    // Track the temp file path for cleanup
    tempFilePath = file.path;

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

    const blobServiceClient = await getUploadBlobServiceClient();
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Use the MIME type from multer (which reads the Content-Type header from the
    // multipart part), or fall back to octet-stream
    const contentType = file.mimetype || "application/octet-stream";

    // Stream the temp file to Azure Blob Storage.
    // uploadStream handles chunking (4 MB blocks) and parallel transfers
    // (5 concurrent) internally, avoiding loading the entire file into memory.
    const fileStream = createReadStream(tempFilePath);
    const uploadBufferSize = 4 * 1024 * 1024;  // 4 MB per block
    const maxConcurrency = 5;

    await blockBlobClient.uploadStream(
      fileStream,
      uploadBufferSize,
      maxConcurrency,
      {
        blobHTTPHeaders: { blobContentType: contentType },
      }
    );

    if (metadata && Object.keys(metadata).length > 0) {
      await blockBlobClient.setMetadata(metadata);
    }

    res.status(200).json({
      success: true,
      blobName,
      containerName,
      contentType,
      size: file.size,
      metadataSet: metadata ? Object.keys(metadata).length : 0,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Upload failed";
    console.error("Upload error:", error);
    if (!res.headersSent) {
      // Distinguish Azure SDK size/timeout errors from other failures
      const isTimeout = message.includes("timeout") || message.includes("ETIMEDOUT");
      const status = isTimeout ? 504 : 500;
      res.status(status).json({
        error: message,
        suggestion: status === 504
          ? "The upload timed out. For large files, use a write SAS URL to upload directly to Azure Blob Storage."
          : "Upload failed. Check server logs for details.",
      });
    }
  } finally {
    // Always clean up the temp file, whether the upload succeeded or failed.
    if (tempFilePath) {
      unlink(tempFilePath).catch(() => { /* best-effort cleanup */ });
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
  console.log(`   Rate limit   : MCP ${RATE_LIMIT_MCP_MAX} / Upload ${RATE_LIMIT_UPLOAD_MAX} per ${RATE_LIMIT_WINDOW_SECONDS}s (API-key-aware)`);
  console.log(`   Session TTL  : ${SESSION_TTL_MS / 60000} minutes`);
  console.log(`   Max sessions : ${MAX_SESSIONS}`);
  console.log(`   SSE keepalive: ${SSE_KEEPALIVE_INTERVAL_MS / 1000}s`);
  console.log(`   JSON limit   : 50mb`);
  console.log(`   Upload limit : ${MAX_UPLOAD_SIZE_MB}mb (streaming via disk)\n`);
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
