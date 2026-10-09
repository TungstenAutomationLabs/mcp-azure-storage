/**
 * Unit tests for structured error handling (Item 1).
 *
 * Verifies that the error wrapper applied via wrapToolErrorHandler
 * converts thrown exceptions to structured JSON error payloads in
 * isError MCP responses, covering every error code path plus
 * SAS sanitisation and success-shape preservation.
 */

import { z } from "zod";

// ── Mock Azure Storage Blob SDK (needed for blob-tools success test) ─────
const mockListBlobsFlat = vi.fn();
const mockExists = vi.fn();

vi.mock("@azure/storage-blob", () => {
  return {
    StorageSharedKeyCredential: vi.fn().mockImplementation(function() { return {}; }),
    BlobServiceClient: vi.fn().mockImplementation(function() { return {
      getContainerClient: vi.fn().mockImplementation(function() { return {
        exists: mockExists,
        create: vi.fn(),
        delete: vi.fn(),
        listBlobsFlat: mockListBlobsFlat,
        getBlockBlobClient: vi.fn().mockImplementation(function() { return {
          uploadData: vi.fn(),
          setMetadata: vi.fn(),
          delete: vi.fn(),
        }; }),
        getBlobClient: vi.fn().mockImplementation(function() { return {
          download: vi.fn(),
          setMetadata: vi.fn(),
          getProperties: vi.fn(),
        }; }),
      }; }),
    }; }),
    generateBlobSASQueryParameters: vi.fn().mockReturnValue({
      toString: () => "sv=2023-01-01&sig=fakesig",
    }),
    BlobSASPermissions: { parse: vi.fn().mockReturnValue({}) },
    ContainerSASPermissions: { parse: vi.fn().mockReturnValue({}) },
    SASProtocol: { HttpsAndHttp: "https,http" },
  };
});

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpPost,
  toolCallRequest,
  extractJsonRpcResponse,
  extractToolJson,
} from "../helpers/mcp-test-harness.js";
import { wrapToolErrorHandler, sanitizeMessage, mapRestError } from "../../src/utils/errors.js";
import type { StructuredError } from "../../src/utils/errors.js";

// ── Helper: create a test app with a throwing tool ──────────────────────────

/**
 * Create a test Express app with the error wrapper applied.
 * Registers a single tool "test-tool" whose handler throws the given error.
 */
function createErrorTestApp(throwFn: () => never): express.Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.post("/mcp", async (req, res) => {
    const mcpServer = new McpServer({ name: "error-test", version: "1.0.0" });
    wrapToolErrorHandler(mcpServer);

    mcpServer.tool(
      "test-tool",
      "A tool that throws for testing",
      { input: z.string().optional().default("test").describe("dummy input") },
      async () => {
        throwFn();
      }
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Internal error";
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message } });
      }
    } finally {
      try { await mcpServer.close(); } catch { /* ignore */ }
    }
  });

  return app;
}

/**
 * Extract the structured error from an MCP tool call response.
 * Expects isError: true with a single text content item containing JSON.
 */
function extractStructuredError(res: any): StructuredError {
  const body = extractJsonRpcResponse(res);
  expect(body.result).toBeDefined();
  expect(body.result.isError).toBe(true);
  expect(body.result.content).toBeDefined();
  expect(body.result.content.length).toBe(1);
  expect(body.result.content[0].type).toBe("text");

  const text = body.result.content[0].text;
  const parsed = JSON.parse(text);
  expect(parsed.error).toBeDefined();
  return parsed.error as StructuredError;
}

/**
 * Create a RestError-like object for testing.
 */
function makeRestError(opts: {
  message: string;
  statusCode?: number;
  code?: string;
  details?: { code?: string; message?: string };
  response?: {
    headers?: { get?(name: string): string | undefined };
    parsedBody?: Record<string, unknown>;
  };
}): Error & Record<string, unknown> {
  const err = new Error(opts.message) as Error & Record<string, unknown>;
  err.name = "RestError";
  if (opts.statusCode !== undefined) err.statusCode = opts.statusCode;
  if (opts.code !== undefined) err.code = opts.code;
  if (opts.details !== undefined) err.details = opts.details;
  if (opts.response !== undefined) err.response = opts.response;
  return err;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("structured-errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Unit tests for sanitizeMessage ───────────────────────────────────────

  describe("sanitizeMessage", () => {
    it("strips sig parameter from SAS URLs", () => {
      const msg =
        "Failed for https://account.blob.core.windows.net/container?sv=2023&sig=abc123secret&se=2025-01-01";
      const result = sanitizeMessage(msg);
      expect(result).toContain("sig=<redacted>");
      expect(result).toContain("se=<redacted>");
      expect(result).not.toContain("abc123secret");
    });

    it("strips sp, sr, sk params", () => {
      const msg = "URL: ?sp=rwd&sr=c&sk=mykey123";
      const result = sanitizeMessage(msg);
      expect(result).toContain("sp=<redacted>");
      expect(result).toContain("sr=<redacted>");
      expect(result).toContain("sk=<redacted>");
      expect(result).not.toContain("rwd");
      expect(result).not.toContain("mykey123");
    });

    it("preserves non-sensitive parts of the message", () => {
      const msg = "BlobNotFound: The specified blob does not exist. RequestId: abc-123";
      const result = sanitizeMessage(msg);
      expect(result).toBe(msg); // no sensitive params to strip
    });

    it("handles empty message", () => {
      expect(sanitizeMessage("")).toBe("");
    });

    it("handles message with multiple SAS URLs", () => {
      const msg = "Source sig=aaa and dest sig=bbb both failed";
      const result = sanitizeMessage(msg);
      expect(result).toBe("Source sig=<redacted> and dest sig=<redacted> both failed");
    });
  });

  // ── Unit tests for mapRestError ──────────────────────────────────────────

  describe("mapRestError", () => {
    it("maps 404 BlobNotFound to not_found", () => {
      const err = makeRestError({
        message: "The specified blob does not exist.",
        statusCode: 404,
        code: "BlobNotFound",
      });
      const result = mapRestError(err);
      expect(result.code).toBe("not_found");
      expect(result.status).toBe(404);
      expect(result.azureCode).toBe("BlobNotFound");
      expect(result.message).toMatch(/^BlobNotFound:/);
      expect(result.retryable).toBe(false);
    });

    it("maps 409 ContainerAlreadyExists to already_exists", () => {
      const err = makeRestError({
        message: "The specified container already exists.",
        statusCode: 409,
        code: "ContainerAlreadyExists",
      });
      const result = mapRestError(err);
      expect(result.code).toBe("already_exists");
      expect(result.status).toBe(409);
      expect(result.azureCode).toBe("ContainerAlreadyExists");
      expect(result.retryable).toBe(false);
    });

    it("maps PopReceiptMismatch to lease_lost", () => {
      const err = makeRestError({
        message: "The specified pop receipt did not match.",
        statusCode: 400,
        code: "PopReceiptMismatch",
      });
      const result = mapRestError(err);
      expect(result.code).toBe("lease_lost");
      expect(result.azureCode).toBe("PopReceiptMismatch");
      expect(result.retryable).toBe(false);
    });

    it("maps BlobImmutableDueToPolicy to immutable without immutableUntil", () => {
      const err = makeRestError({
        message: "This blob is immutable.",
        statusCode: 409,
        code: "BlobImmutableDueToPolicy",
      });
      const result = mapRestError(err);
      expect(result.code).toBe("immutable");
      expect(result.azureCode).toBe("BlobImmutableDueToPolicy");
      expect(result.retryable).toBe(false);
      expect(result.immutableUntil).toBeUndefined();
    });

    it("maps BlobImmutableDueToPolicy to immutable with immutableUntil", () => {
      const err = makeRestError({
        message: "This blob is immutable.",
        statusCode: 409,
        code: "BlobImmutableDueToPolicy",
        response: {
          parsedBody: { ImmutabilityPolicyExpiresOn: "2025-12-31T00:00:00Z" },
        },
      });
      const result = mapRestError(err);
      expect(result.code).toBe("immutable");
      expect(result.immutableUntil).toBe("2025-12-31T00:00:00Z");
    });

    it("maps BlobArchived to archived with archiveStatus", () => {
      const err = makeRestError({
        message: "This blob is archived.",
        statusCode: 409,
        code: "BlobArchived",
        response: {
          parsedBody: { ArchiveStatus: "rehydrate-pending-to-hot" },
        },
      });
      const result = mapRestError(err);
      expect(result.code).toBe("archived");
      expect(result.azureCode).toBe("BlobArchived");
      expect(result.archiveStatus).toBe("rehydrate-pending-to-hot");
      expect(result.retryable).toBe(false);
    });

    it("maps BlobArchived to archived without archiveStatus", () => {
      const err = makeRestError({
        message: "This blob is archived.",
        statusCode: 409,
        code: "BlobArchived",
      });
      const result = mapRestError(err);
      expect(result.code).toBe("archived");
      expect(result.archiveStatus).toBeUndefined();
    });

    it("maps 429 to rate_limited with retryAfterSeconds", () => {
      const err = makeRestError({
        message: "Rate limit exceeded",
        statusCode: 429,
        code: "TooManyRequests",
        response: {
          headers: { get: (name: string) => name.toLowerCase() === "retry-after" ? "30" : undefined },
        },
      });
      const result = mapRestError(err);
      expect(result.code).toBe("rate_limited");
      expect(result.status).toBe(429);
      expect(result.retryable).toBe(true);
      expect(result.retryAfterSeconds).toBe(30);
    });

    it("maps 429 without Retry-After header", () => {
      const err = makeRestError({
        message: "Rate limit exceeded",
        statusCode: 429,
        code: "TooManyRequests",
      });
      const result = mapRestError(err);
      expect(result.code).toBe("rate_limited");
      expect(result.retryable).toBe(true);
      expect(result.retryAfterSeconds).toBeUndefined();
    });

    it("maps InvalidArgumentError to invalid with field", () => {
      const err = new Error("containerName must be lowercase") as Error & Record<string, unknown>;
      err.name = "InvalidArgumentError";
      err.field = "containerName";
      const result = mapRestError(err);
      expect(result.code).toBe("invalid");
      expect(result.field).toBe("containerName");
      expect(result.retryable).toBe(false);
    });

    it("maps ERR_INVALID_ARG code to invalid", () => {
      const err = new Error("bad arg") as Error & Record<string, unknown>;
      err.code = "ERR_INVALID_ARG";
      const result = mapRestError(err);
      expect(result.code).toBe("invalid");
      expect(result.retryable).toBe(false);
    });

    it("maps 403 to forbidden", () => {
      const err = makeRestError({
        message: "Forbidden",
        statusCode: 403,
        code: "AuthorizationFailure",
      });
      const result = mapRestError(err);
      expect(result.code).toBe("forbidden");
      expect(result.status).toBe(403);
      expect(result.retryable).toBe(false);
    });

    it("maps 400 to invalid", () => {
      const err = makeRestError({
        message: "Invalid header value",
        statusCode: 400,
        code: "InvalidHeaderValue",
      });
      const result = mapRestError(err);
      expect(result.code).toBe("invalid");
      expect(result.status).toBe(400);
      expect(result.azureCode).toBe("InvalidHeaderValue");
    });

    it("maps 500 RestError to backend with retryable=true", () => {
      const err = makeRestError({
        message: "Internal server error",
        statusCode: 500,
        code: "InternalError",
      });
      const result = mapRestError(err);
      expect(result.code).toBe("backend");
      expect(result.status).toBe(500);
      expect(result.azureCode).toBe("InternalError");
      expect(result.retryable).toBe(true);
    });

    it("maps 503 RestError to backend with retryable=true", () => {
      const err = makeRestError({
        message: "Service unavailable",
        statusCode: 503,
        code: "ServerBusy",
      });
      const result = mapRestError(err);
      expect(result.code).toBe("backend");
      expect(result.status).toBe(503);
      expect(result.retryable).toBe(true);
    });

    it("maps generic Error to backend with status null", () => {
      const err = new Error("Something went wrong");
      const result = mapRestError(err);
      expect(result.code).toBe("backend");
      expect(result.status).toBeNull();
      expect(result.message).toBe("Something went wrong");
      expect(result.retryable).toBe(false);
    });

    it("maps non-Error to backend with stringified message", () => {
      const result = mapRestError("string error");
      expect(result.code).toBe("backend");
      expect(result.status).toBeNull();
      expect(result.message).toBe("string error");
    });

    it("maps TooLargeError to too_large with maxBytes", () => {
      const err = new Error("File exceeds 50MB limit") as Error & Record<string, unknown>;
      err.name = "TooLargeError";
      err.maxBytes = 52428800;
      const result = mapRestError(err);
      expect(result.code).toBe("too_large");
      expect(result.maxBytes).toBe(52428800);
      expect(result.retryable).toBe(false);
    });

    it("sanitises SAS tokens in RestError messages", () => {
      const err = makeRestError({
        message: "Failed for https://acct.blob.core.windows.net/c?sig=SECRETKEY123&se=2025-01-01",
        statusCode: 500,
        code: "InternalError",
      });
      const result = mapRestError(err);
      expect(result.message).not.toContain("SECRETKEY123");
      expect(result.message).toContain("sig=<redacted>");
    });

    it("prefers details.code over top-level code", () => {
      const err = makeRestError({
        message: "Not found",
        statusCode: 404,
        code: "REQUEST_SEND_ERROR",
        details: { code: "BlobNotFound" },
      });
      const result = mapRestError(err);
      expect(result.code).toBe("not_found");
      expect(result.azureCode).toBe("BlobNotFound");
    });
  });

  // ── Integration tests: wrapper → MCP response ────────────────────────────

  describe("MCP error response integration", () => {
    it("returns isError with not_found for 404 BlobNotFound", async () => {
      const app = createErrorTestApp(() => {
        throw makeRestError({
          message: "The specified blob does not exist.",
          statusCode: 404,
          code: "BlobNotFound",
        });
      });

      const res = await mcpPost(app, toolCallRequest("test-tool")).expect(200);
      const structured = extractStructuredError(res);
      expect(structured.code).toBe("not_found");
      expect(structured.status).toBe(404);
      expect(structured.azureCode).toBe("BlobNotFound");
      expect(structured.message).toMatch(/^BlobNotFound:/);
      expect(structured.retryable).toBe(false);
    });

    it("returns isError with already_exists for 409 ContainerAlreadyExists", async () => {
      const app = createErrorTestApp(() => {
        throw makeRestError({
          message: "The specified container already exists.",
          statusCode: 409,
          code: "ContainerAlreadyExists",
        });
      });

      const res = await mcpPost(app, toolCallRequest("test-tool")).expect(200);
      const structured = extractStructuredError(res);
      expect(structured.code).toBe("already_exists");
      expect(structured.status).toBe(409);
      expect(structured.azureCode).toBe("ContainerAlreadyExists");
    });

    it("returns isError with lease_lost for PopReceiptMismatch", async () => {
      const app = createErrorTestApp(() => {
        throw makeRestError({
          message: "The specified pop receipt did not match.",
          statusCode: 400,
          code: "PopReceiptMismatch",
        });
      });

      const res = await mcpPost(app, toolCallRequest("test-tool")).expect(200);
      const structured = extractStructuredError(res);
      expect(structured.code).toBe("lease_lost");
      expect(structured.azureCode).toBe("PopReceiptMismatch");
    });

    it("returns isError with immutable for BlobImmutableDueToPolicy", async () => {
      const app = createErrorTestApp(() => {
        throw makeRestError({
          message: "This blob is immutable.",
          statusCode: 409,
          code: "BlobImmutableDueToPolicy",
          response: {
            parsedBody: { ImmutabilityPolicyExpiresOn: "2026-06-30T00:00:00Z" },
          },
        });
      });

      const res = await mcpPost(app, toolCallRequest("test-tool")).expect(200);
      const structured = extractStructuredError(res);
      expect(structured.code).toBe("immutable");
      expect(structured.immutableUntil).toBe("2026-06-30T00:00:00Z");
    });

    it("returns isError with archived for BlobArchived", async () => {
      const app = createErrorTestApp(() => {
        throw makeRestError({
          message: "This blob is archived.",
          statusCode: 409,
          code: "BlobArchived",
          response: {
            parsedBody: { ArchiveStatus: "rehydrate-pending-to-hot" },
          },
        });
      });

      const res = await mcpPost(app, toolCallRequest("test-tool")).expect(200);
      const structured = extractStructuredError(res);
      expect(structured.code).toBe("archived");
      expect(structured.archiveStatus).toBe("rehydrate-pending-to-hot");
    });

    it("returns isError with rate_limited for 429 with Retry-After", async () => {
      const app = createErrorTestApp(() => {
        throw makeRestError({
          message: "Rate limit exceeded",
          statusCode: 429,
          code: "TooManyRequests",
          response: {
            headers: {
              get: (name: string) => name.toLowerCase() === "retry-after" ? "60" : undefined,
            },
          },
        });
      });

      const res = await mcpPost(app, toolCallRequest("test-tool")).expect(200);
      const structured = extractStructuredError(res);
      expect(structured.code).toBe("rate_limited");
      expect(structured.retryable).toBe(true);
      expect(structured.retryAfterSeconds).toBe(60);
    });

    it("returns isError with invalid for InvalidArgumentError with field", async () => {
      const app = createErrorTestApp(() => {
        const err = new Error("containerName must be lowercase") as Error & Record<string, unknown>;
        err.name = "InvalidArgumentError";
        err.field = "containerName";
        throw err;
      });

      const res = await mcpPost(app, toolCallRequest("test-tool")).expect(200);
      const structured = extractStructuredError(res);
      expect(structured.code).toBe("invalid");
      expect(structured.field).toBe("containerName");
      expect(structured.message).toContain("containerName must be lowercase");
    });

    it("returns isError with backend for 500 RestError (retryable)", async () => {
      const app = createErrorTestApp(() => {
        throw makeRestError({
          message: "Internal server error",
          statusCode: 500,
          code: "InternalError",
        });
      });

      const res = await mcpPost(app, toolCallRequest("test-tool")).expect(200);
      const structured = extractStructuredError(res);
      expect(structured.code).toBe("backend");
      expect(structured.status).toBe(500);
      expect(structured.azureCode).toBe("InternalError");
      expect(structured.retryable).toBe(true);
    });

    it("returns isError with forbidden for 403", async () => {
      const app = createErrorTestApp(() => {
        throw makeRestError({
          message: "Forbidden",
          statusCode: 403,
          code: "AuthorizationFailure",
        });
      });

      const res = await mcpPost(app, toolCallRequest("test-tool")).expect(200);
      const structured = extractStructuredError(res);
      expect(structured.code).toBe("forbidden");
      expect(structured.status).toBe(403);
    });

    it("sanitises SAS tokens in error messages", async () => {
      const app = createErrorTestApp(() => {
        throw makeRestError({
          message: "Failure at https://acct.blob.core.windows.net/c?sig=TOP_SECRET_SIG&se=2025-12-31&sp=r",
          statusCode: 500,
          code: "InternalError",
        });
      });

      const res = await mcpPost(app, toolCallRequest("test-tool")).expect(200);
      const structured = extractStructuredError(res);
      expect(structured.message).not.toContain("TOP_SECRET_SIG");
      expect(structured.message).toContain("sig=<redacted>");
      expect(structured.message).toContain("se=<redacted>");
      expect(structured.message).toContain("sp=<redacted>");
    });
  });

  // ── Success shape unchanged ──────────────────────────────────────────────

  describe("success response unchanged", () => {
    it("blob-container-exists returns unchanged success shape through wrapper", async () => {
      // Use the real blob-tools registration but with the wrapper applied
      const { registerBlobTools } = await import("../../src/tools/blob-tools.js");

      const app = express();
      app.use(express.json({ limit: "10mb" }));

      app.post("/mcp", async (req, res) => {
        const mcpServer = new McpServer({ name: "success-test", version: "1.0.0" });
        wrapToolErrorHandler(mcpServer);
        registerBlobTools(mcpServer);

        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        try {
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Internal error";
          if (!res.headersSent) {
            res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message } });
          }
        } finally {
          try { await mcpServer.close(); } catch { /* ignore */ }
        }
      });

      // Mock a successful exists call
      mockExists.mockResolvedValue(true);

      const response = await mcpPost(
        app,
        toolCallRequest("blob-container-exists", { containerName: "test-container" })
      ).expect(200);

      const json = extractToolJson(response);
      expect(json).toEqual({ exists: true });

      // Verify the response shape: content array with a single text item, no isError
      const body = extractJsonRpcResponse(response);
      expect(body.result.isError).toBeFalsy();
      expect(body.result.content).toHaveLength(1);
      expect(body.result.content[0].type).toBe("text");
    });
  });
});
