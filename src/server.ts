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
import Busboy from "busboy";
import { PassThrough } from "stream";
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
import { parseDisabledTools, buildDisabledToolError } from "./utils/disabled-tools.js";

// Re-export for backward compatibility (tests, external consumers)
export { parseDisabledTools, buildDisabledToolError } from "./utils/disabled-tools.js";

// ── Disabled tools ───────────────────────────────────────────────────────────
// DISABLED_TOOLS env var: comma-separated tool names (case-insensitive) to
// exclude from registration and reject on invocation. Empty/undefined = no
// tools disabled.

/** Canonical set of disabled tool names (lowercase) parsed once at startup. */
export const disabledToolNames = parseDisabledTools(process.env.DISABLED_TOOLS);

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

// ── Body size limits ─────────────────────────────────────────────────────────
// MAX_UPLOAD_BYTES — hard byte limit for streaming multipart uploads via /upload.
//   Default: 5 GiB (5368709120). Files beyond this should use a write SAS URL.
// MAX_JSON_BODY_BYTES — hard byte limit for JSON bodies on /mcp (base64 payloads).
//   Default: 50 MiB (52428800). Controls express.json({ limit }).
export const MAX_UPLOAD_BYTES = parseInt(
  process.env.MAX_UPLOAD_BYTES || String(5 * 1024 * 1024 * 1024), 10
);
export const MAX_JSON_BODY_BYTES = parseInt(
  process.env.MAX_JSON_BODY_BYTES || String(50 * 1024 * 1024), 10
);

// Accept large JSON payloads (base64-encoded files can be tens of MB).
// Files beyond this limit should use the multipart /upload endpoint instead.
app.use(express.json({ limit: MAX_JSON_BODY_BYTES }));

// ── JSON body parser error handler ───────────────────────────────────────────
// When express.json() rejects a request (e.g. PayloadTooLargeError), Express
// emits a bare 500. This middleware intercepts those errors and returns
// structured JSON with the correct HTTP status so callers can choose an
// alternative path (multipart upload, SAS URL, etc.) instead of discovering
// the limit by failing.
app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err.type === "entity.too.large") {
    res.status(413).json({
      code: "too_large",
      error: `Request body too large: ${err.message}`,
      suggestion: "For large files, use the multipart POST /upload endpoint instead of base64 encoding. " +
        "For files beyond the upload limit, use 'blob-get-sas-url' to get a direct write URL.",
      maxJsonBodyBytes: MAX_JSON_BODY_BYTES,
    });
    return;
  }
  // Pass other errors through
  next(err);
});

// ── MCP server factory ───────────────────────────────────────────────────────

/**
 * Create a fresh MCP server instance with all tools and resources.
 *
 * A new instance is created for each stateful session and each stateless
 * request. Tool and resource registrations read the shared singleton
 * StorageConfig and SDK clients from their respective modules, so this
 * is lightweight.
 *
 * When DISABLED_TOOLS is configured, disabled tool names are silently
 * skipped during registration. The `disabledToolNames` set is used by
 * the pre-dispatch guard in the POST /mcp handler to reject calls to
 * disabled tools with a structured forbidden error.
 *
 * @returns A fully-configured McpServer ready to connect to a transport.
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "azure-storage-mcp",
    version: "1.2.0",
  });

  // ── Structured error wrapper ───────────────────────────────────────────
  // Patches server.tool() so every handler is wrapped in try/catch.
  // On error the wrapper converts the exception to a StructuredError JSON
  // payload and re-throws, so the MCP SDK returns isError: true with the
  // JSON string as the text content. Must be called before tool registration.
  wrapToolErrorHandler(server);

  // ── Disabled-tool gating layer ─────────────────────────────────────────
  // If DISABLED_TOOLS is configured, wrap server.tool() a second time
  // (after the error wrapper) to silently skip registration for any tool
  // whose name appears in the disabled set. This means disabled tools are
  // never registered, so they don't appear in tools/list and can't be
  // invoked through the MCP SDK path. The pre-dispatch guard in the POST
  // /mcp handler provides a belt-and-suspenders safeguard.
  if (disabledToolNames.size > 0) {
    const origTool = server.tool.bind(server);
    (server as any).tool = function gatedTool(...args: unknown[]) {
      // The first argument is always the tool name (string).
      const toolName = args[0];
      if (typeof toolName === "string" && disabledToolNames.has(toolName.toLowerCase())) {
        // Skip registration entirely — tool will not appear in tools/list
        return;
      }
      return (origTool as Function).apply(server, args);
    };
  }

  // ── Tools — actions that read or mutate storage ──
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

// ── Startup validation: warn on unknown disabled tool names ──────────────────
// Runs once after the first createMcpServer() call to discover the full set of
// registered tool names, then compares against DISABLED_TOOLS. Unknown names
// are logged as warnings but do not prevent server startup.
let _disabledToolsValidated = false;

function validateDisabledToolNames(): void {
  if (_disabledToolsValidated || disabledToolNames.size === 0) return;
  _disabledToolsValidated = true;

  // Create a temporary server with NO disabled gating to discover all known tools.
  const tempServer = new McpServer({ name: "tool-discovery", version: "0.0.0" });
  wrapToolErrorHandler(tempServer);
  registerBlobTools(tempServer);
  registerTableTools(tempServer);
  registerQueueTools(tempServer);
  registerFileShareTools(tempServer);
  registerUtilityTools(tempServer);

  // Extract registered tool names from the internal _registeredTools map.
  // The MCP SDK stores tools in a Map<string, RegisteredTool>.
  const knownTools = new Set<string>();
  const registeredToolsMap = (tempServer as any)._registeredTools;
  if (registeredToolsMap instanceof Map) {
    for (const name of registeredToolsMap.keys()) {
      knownTools.add((name as string).toLowerCase());
    }
  }

  for (const disabled of disabledToolNames) {
    if (!knownTools.has(disabled)) {
      console.warn(`⚠️  DISABLED_TOOLS contains unknown tool name: '${disabled}'`);
    }
  }

  // Clean up temp server
  try { tempServer.close(); } catch { /* ignore */ }
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

  // ─── Pre-dispatch guard: reject calls to disabled tools ───
  // Check before any session routing so disabled tools are rejected consistently
  // regardless of stateful/stateless mode. Only applies to tools/call requests.
  if (disabledToolNames.size > 0) {
    const body = req.body;
    const isToolCall = body?.method === "tools/call";
    if (isToolCall) {
      const targetTool = body?.params?.name;
      if (typeof targetTool === "string" && disabledToolNames.has(targetTool.toLowerCase())) {
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
  }

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
// POST /upload — Direct file upload via multipart form-data (streaming)
//
// This REST endpoint bypasses the MCP JSON-RPC transport entirely, allowing
// any HTTP client (curl, Python, browser, CI/CD) to upload files directly
// to Azure Blob Storage without base64 encoding.
//
// The file is streamed directly from the HTTP request to Azure Blob Storage
// via busboy + BlockBlobClient.uploadStream. No temp files, no full-file
// buffering in memory. This keeps RSS bounded even for multi-GB uploads.
//
// If Content-Length exceeds MAX_UPLOAD_BYTES, the request is rejected
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

/**
 * Content-Length pre-check middleware.
 *
 * If the Content-Length header indicates a file larger than the configured
 * limit, reject immediately with 413 and a helpful JSON body. For requests
 * that include a containerName and blobName in the query string, we include
 * a pre-signed write SAS URL so the caller can upload directly to Azure
 * Storage instead.
 *
 * This fires BEFORE busboy starts consuming the request body, so the
 * connection is closed cleanly — no partial reads, no hung streams.
 */
function uploadSizeGuard(req: Request, res: Response, next: NextFunction): void {
  const contentLength = parseInt(req.headers["content-length"] || "0", 10);

  if (contentLength > MAX_UPLOAD_BYTES) {
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
      code: "too_large",
      error: "File too large",
      maxBytes: MAX_UPLOAD_BYTES,
      suggestion: "Reduce file size or split into parts",
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

/**
 * Streaming upload handler using busboy.
 *
 * Parses multipart/form-data on the fly. The file field ("file") is piped
 * through a metered PassThrough that enforces MAX_UPLOAD_BYTES at the stream
 * level, then directly to Azure Blob Storage via BlockBlobClient.uploadStream.
 *
 * Because uploadStream commits the blob only after ALL blocks are uploaded
 * (via commitBlockList), aborting the stream mid-upload means the final
 * commit never happens and no partial blob is visible.
 *
 * Form fields (containerName, blobName, metadata) may arrive before or after
 * the file — busboy emits them in order, so we collect fields as they arrive
 * and start the Azure upload only once the file stream begins. Field
 * validation happens after busboy's "close" event when all parts have been
 * received.
 */
app.post("/upload", apiKeyAuth, uploadLimiter, uploadSizeGuard, (req: Request, res: Response) => {
  // Guard: Content-Type must be multipart/form-data
  const ct = req.headers["content-type"] || "";
  if (!ct.includes("multipart/form-data")) {
    res.status(400).json({ error: "Expected Content-Type: multipart/form-data" });
    return;
  }

  // ── State for collecting form parts ──
  const fields: Record<string, string> = {};
  let fileReceived = false;
  let fileName = "";
  let mimeType = "application/octet-stream";
  let bytesReceived = 0;
  let limitExceeded = false;
  let responded = false;    // guard against double-response
  let uploadPromise: Promise<void> | null = null;
  let filePassThrough: PassThrough | null = null;

  // ── Constants for Azure upload ──
  const UPLOAD_BUFFER_SIZE = 4 * 1024 * 1024; // 4 MiB per block
  const MAX_BUFFERS = 4;                       // bounded concurrency

  const bb = Busboy({
    headers: req.headers as Record<string, string>,
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,        // accept exactly one file field
    },
  });

  // ── Field handler — collect containerName, blobName, metadata ──
  bb.on("field", (name: string, value: string) => {
    fields[name] = value;
  });

  // ── File handler — stream to Azure via PassThrough ──
  bb.on("file", (name: string, stream, info) => {
    if (name !== "file") {
      // Drain unexpected file fields
      stream.resume();
      return;
    }

    fileReceived = true;
    fileName = info.filename;
    mimeType = info.mimeType || "application/octet-stream";

    // Metered PassThrough — counts bytes and enforces limit
    filePassThrough = new PassThrough();

    stream.on("data", (chunk: Buffer) => {
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_UPLOAD_BYTES && !limitExceeded) {
        limitExceeded = true;
        // Destroy the PassThrough to signal abort to uploadStream.
        // This causes uploadStream to reject before committing.
        filePassThrough!.destroy(new Error("too_large"));
        stream.destroy();
      }
    });

    // busboy emits 'limit' when fileSize limit is hit
    stream.on("limit", () => {
      if (!limitExceeded) {
        limitExceeded = true;
        filePassThrough!.destroy(new Error("too_large"));
      }
    });

    stream.pipe(filePassThrough);

    // Start the Azure upload immediately — uploadStream reads from the
    // PassThrough as data arrives. The commit happens only when the stream
    // ends successfully (all blocks uploaded + commitBlockList).
    uploadPromise = (async () => {
      const containerName = fields.containerName;
      const blobName = fields.blobName || fileName;

      // We start the upload even before we've validated fields, because
      // fields may arrive after the file in the multipart stream. The
      // actual Azure call needs containerName/blobName, so if they haven't
      // arrived yet we defer validation to the "close" handler. However,
      // uploadStream needs a real client, so we start it here only if we
      // have enough info. If containerName isn't available yet, we buffer
      // into the PassThrough until close, then validate + upload.
      //
      // For simplicity and reliability: we always pipe to the PassThrough,
      // and start the Azure upload in the close handler after all fields
      // are known. However, this means the PassThrough buffers data until
      // close is called for field validation — but uploadStream consumes
      // the PassThrough concurrently (it reads in 4 MiB chunks), so memory
      // stays bounded as long as we start the upload early.
      //
      // Revised approach: start upload here if containerName is already
      // available (most clients send fields before file), otherwise the
      // close handler will do it.
      if (!containerName) {
        // Fields haven't arrived yet — upload will be started in close handler
        return;
      }

      const blobServiceClient = await getUploadBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      await blockBlobClient.uploadStream(
        filePassThrough!,
        UPLOAD_BUFFER_SIZE,
        MAX_BUFFERS,
        {
          blobHTTPHeaders: { blobContentType: mimeType },
        }
      );
    })();
  });

  // ── Close handler — all parts received; validate and respond ──
  bb.on("close", async () => {
    if (responded) return;

    // ── Check if the stream limit was exceeded ──
    if (limitExceeded) {
      responded = true;
      if (!res.headersSent) {
        res.status(413).json({
          code: "too_large",
          error: "File too large",
          maxBytes: MAX_UPLOAD_BYTES,
          suggestion: "Reduce file size or split into parts",
        });
      }
      return;
    }

    // ── Validate required fields ──
    if (!fileReceived) {
      responded = true;
      res.status(400).json({ error: "No file provided. Send a multipart form with a 'file' field." });
      return;
    }

    const containerName = fields.containerName;
    if (!containerName) {
      responded = true;
      // Destroy the PassThrough to abort any pending upload
      filePassThrough?.destroy(new Error("missing_field"));
      res.status(400).json({ error: "Missing required field: containerName" });
      return;
    }

    const blobName = fields.blobName || fileName;
    if (!blobName) {
      responded = true;
      filePassThrough?.destroy(new Error("missing_field"));
      res.status(400).json({ error: "Missing required field: blobName (or upload a file with a filename)" });
      return;
    }

    // ── Parse optional metadata ──
    let metadata: Record<string, string> | undefined;
    if (fields.metadata) {
      try {
        metadata = JSON.parse(fields.metadata);
      } catch {
        responded = true;
        filePassThrough?.destroy(new Error("invalid_metadata"));
        res.status(400).json({ error: "Invalid metadata JSON. Provide a JSON object string, e.g. '{\"author\":\"Alice\"}'" });
        return;
      }
    }

    try {
      // If upload was already started (containerName was available when file arrived),
      // just wait for it to complete. Otherwise, start it now.
      if (uploadPromise) {
        await uploadPromise;
        // If the upload promise resolved without actually calling uploadStream
        // (because containerName wasn't available), we need to do it now
        if (!fields.containerName) {
          // This branch shouldn't normally happen — containerName was checked above
          throw new Error("containerName not available for upload");
        }
      }

      // If uploadPromise was null (no file handler fired — shouldn't happen since
      // fileReceived is true above), or if containerName wasn't available when the
      // file handler fired, do the upload now.
      if (!uploadPromise || !fields.containerName) {
        // containerName was validated above, so this is the deferred-upload path
        const blobServiceClient = await getUploadBlobServiceClient();
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        await blockBlobClient.uploadStream(
          filePassThrough!,
          UPLOAD_BUFFER_SIZE,
          MAX_BUFFERS,
          {
            blobHTTPHeaders: { blobContentType: mimeType },
          }
        );
      }

      // ── Set metadata (separate call, after blob is committed) ──
      if (metadata && Object.keys(metadata).length > 0) {
        const blobServiceClient = await getUploadBlobServiceClient();
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.setMetadata(metadata);
      }

      responded = true;
      res.status(200).json({
        success: true,
        blobName,
        containerName,
        contentType: mimeType,
        size: bytesReceived,
        metadataSet: metadata ? Object.keys(metadata).length : 0,
      });
    } catch (error: unknown) {
      if (responded) return;
      responded = true;
      const message = error instanceof Error ? error.message : "Upload failed";

      // Check if this was a limit error from our metered stream
      if (message === "too_large") {
        if (!res.headersSent) {
          res.status(413).json({
            code: "too_large",
            error: "File too large",
            maxBytes: MAX_UPLOAD_BYTES,
            suggestion: "Reduce file size or split into parts",
          });
        }
        return;
      }

      console.error("Upload error:", error);
      if (!res.headersSent) {
        const isTimeout = message.includes("timeout") || message.includes("ETIMEDOUT");
        const status = isTimeout ? 504 : 500;
        res.status(status).json({
          error: message,
          suggestion: status === 504
            ? "The upload timed out. For large files, use a write SAS URL to upload directly to Azure Blob Storage."
            : "Upload failed. Check server logs for details.",
        });
      }
    }
  });

  // ── Error handler — busboy parse errors ──
  bb.on("error", (err: Error) => {
    if (responded) return;
    responded = true;
    filePassThrough?.destroy(err);
    console.error("Busboy parse error:", err);
    if (!res.headersSent) {
      res.status(400).json({ error: `Multipart parse error: ${err.message}` });
    }
  });

  // ── Client abort — destroy busboy to stop processing ──
  req.on("close", () => {
    if (!res.writableFinished) {
      // Client disconnected before upload completed
      filePassThrough?.destroy(new Error("client_aborted"));
    }
  });

  // Pipe the incoming request into busboy
  req.pipe(bb);
});

// ── Start HTTP server ────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const httpServer = app.listen(PORT, () => {
  console.log(`\n🚀 MCP Azure Storage Server v1.2.0`);
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
  console.log(`   JSON limit   : ${(MAX_JSON_BODY_BYTES / (1024 * 1024)).toFixed(0)}mb`);
  console.log(`   Upload limit : ${(MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)}mb (streaming to Azure)`);
  if (disabledToolNames.size > 0) {
    console.log(`   Disabled tools: ${[...disabledToolNames].join(", ")}`);
  }
  console.log(""); // trailing newline

  // Validate DISABLED_TOOLS names against known tools (logs warnings for unknowns)
  validateDisabledToolNames();
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
