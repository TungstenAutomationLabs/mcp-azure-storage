# MCP Azure Storage Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes **42 tools** and **12 resources** for managing Azure Storage — Blob, Queue, Table, and File Share — over a single HTTP endpoint. Designed for use with AI assistants (Claude, RooCode, Copilot), Postman, MCP Inspector, and any MCP-compatible client.

Deploys to **Azure Container Apps** with automatic HTTPS, user-assigned managed identity, and Bicep infrastructure-as-code.

---

## Features

- **42 MCP tools** across 5 categories (Blob, Queue, Table, File Share, Utilities)
- **12 MCP resources** — read-only, URI-addressable data for LLM context (listings, content reads, properties)
- **Direct file upload** — `POST /upload` endpoint streams multipart form-data to Azure via busboy (no temp files, no full-file buffering)
- **URL-based upload** — `blob-upload-from-url` tool fetches files server-side (no base64 through LLM context)
- **Dual-mode transport** — stateful sessions for MCP clients + stateless one-shot for HTTP testing
- **API key authentication** with constant-time comparison (X-API-Key header or Bearer token)
- **Rate limiting** — per-endpoint budgets with API-key-aware identity; configurable window and max requests
- **Security headers** via Helmet
- **Session TTL** — automatic cleanup of idle sessions (30 min)
- **SAS token generation** — blob and container-level shared access signatures with expiry ceiling and protocol control
- **Tool gating** — `DISABLED_TOOLS` env var to disable specific tools at runtime (omitted from listings; forbidden on invocation)
- **Server introspection** — `store-info` tool exposes limits, auth mode, endpoints, and disabled tools (no secrets)
- **Base64 content encoding** — upload/download binary files through JSON
- **Docker** — multi-stage build, non-root container user
- **Azure Container Apps** — Bicep IaC, user-assigned managed identity, auto-HTTPS, auto-scaling (1–5 replicas)

---

## Architecture Overview

```
┌─────────────────────┐      HTTPS / JSON-RPC 2.0
│  MCP Client         │──────────────────────────────┐
│  (Claude, RooCode,  │                              │
│   Postman, etc.)    │                              ▼
└─────────────────────┘               ┌──────────────────────────┐
                                      │  Express.js Server       │
                                      │  ├─ Helmet (headers)     │
                                      │  ├─ Rate Limiter         │
                                      │  ├─ API Key Auth         │
                                      │  └─ MCP Transport        │
                                      │     ├─ Stateful (session)│
                                      │     └─ Stateless (1-shot)│
                                      └──────────┬───────────────┘
                                                  │
                      ┌───────────────────────────┬┴──────────────────────────┐
                      │      42 Tools (actions)   │    12 Resources (reads)   │
                      ├───────────────────────────┼───────────────────────────┤
                      │ Blob (13) │ Queue (8)     │ Blob (4)  │ Queue (2)    │
                      │ Table (5) │ FileShare (8) │ Table (2) │ FileShare (4)│
                      │ Utility (8)               │                          │
                      └───────────┬───────────────┴──────────┬───────────────┘
                                  │                          │
                                  └──────────┬───────────────┘
                                             │
                                  ┌──────────▼──────────┐
                                  │  Azure Storage      │
                                  │  (SharedKey auth)   │
                                  └─────────────────────┘
```

---

## Repository Guide

```
mcp-azure-storage/
├── src/
│   ├── server.ts              # Express app, MCP transport, session management
│   ├── config.ts              # Storage config from env vars (singleton)
│   ├── middleware/
│   │   └── api-key.ts         # API key auth (X-API-Key / Bearer)
│   ├── tools/
│   │   ├── blob-tools.ts      # 13 tools — container + blob CRUD, head, set-tier, SAS, metadata, URL upload
│   │   ├── queue-tools.ts     #  8 tools — queue CRUD + message operations + lease renewal
│   │   ├── table-tools.ts     #  5 tools — table CRUD + entity operations
│   │   ├── fileshare-tools.ts #  8 tools — share/directory/file operations
│   │   └── utility-tools.ts   #  7 tools — base64, SAS refresh, MIME lookup, upload info
│   └── utils/
│       ├── errors.ts              # Structured error mapping + server.tool() wrapper
│       └── format.ts              # Response formatting (JSON/HTML/MD) utility
│   └── resources/
│       ├── blob-resources.ts      #  4 resources — containers, blobs, properties
│       ├── fileshare-resources.ts #  4 resources — shares, files, properties
│       ├── queue-resources.ts     #  2 resources — queues, queue properties
│       └── table-resources.ts     #  2 resources — tables, entity lookup
├── tests/
│   ├── setup.ts               # Test env bootstrap (dummy credentials)
│   ├── config.test.ts         # Config module tests
│   ├── helpers/
│   │   └── mcp-test-harness.ts  # Stateless MCP endpoint + SSE-aware helpers
│   ├── middleware/
│   │   └── api-key.test.ts    # API key auth tests (503/401/403/pass-through)
│   ├── tools/
│   │   ├── blob-tools.test.ts           # 42 tests — mock Azure Blob SDK + SSRF + lifecycle
│   │   ├── queue-tools.test.ts          # 27 tests — mock Azure Queue SDK + lease renewal
│   │   ├── table-tools.test.ts          #  7 tests — mock Azure Tables SDK
│   │   ├── fileshare-tools.test.ts      #  6 tests — mock Azure File Share SDK
│   │   ├── utility-tools.test.ts        # 10 tests — base64, MIME, container name, upload URL
│   │   └── structured-errors.test.ts    # 36 tests — error mapping, SAS sanitisation, MCP integration
│   ├── resources/
│   │   ├── blob-resources.test.ts      # 6 tests — list cap, download guard
│   │   ├── queue-resources.test.ts     # 3 tests — list cap, properties
│   │   ├── table-resources.test.ts     # 3 tests — list cap, entity lookup
│   │   └── fileshare-resources.test.ts # 4 tests — list cap, size guard
│   ├── utils/
│   │   └── format.test.ts             # 20 tests — JSON/HTML/MD formatting
│   └── integration/
│       ├── blob-integration.test.ts    # Azurite blob CRUD smoke test
│       ├── queue-integration.test.ts   # Azurite queue CRUD smoke test
│       └── table-integration.test.ts   # Azurite table CRUD smoke test
├── infra/
│   ├── main.bicep             # Azure Container Apps + Storage + Identity + RBAC
│   └── main.parameters.json   # azd-templated deployment parameters
├── deploy_to_azure.ps1        # One-command deploy script (reads .env, syncs to azd, deploys)
├── .github/workflows/
│   └── ci.yml                 # GitHub Actions — unit + integration tests
├── docker-compose.azurite.yml # Azurite emulator for local integration tests
├── vitest.config.ts           # Unit test config (coverage, thresholds)
├── vitest.integration.config.ts # Integration test config (Azurite)
├── .env.test                  # Azurite well-known credentials for tests
├── Dockerfile                 # Multi-stage build, non-root user
├── .dockerignore              # Excludes .env, docs, infra from image
├── azure.yaml                 # Azure Developer CLI project definition
├── ENVIRONMENTS.md            # Multi-environment deployment guide (dev, test, prod)
├── .azure.env.example         # Template for azd deployment environment variables
├── .env.example               # Template for local environment variables
├── .gitignore                 # Ignores .env, dist, node_modules, docs
├── tsconfig.json              # TypeScript configuration
├── package.json               # Dependencies and scripts
└── LICENSE                    # Project license
```

---

## Response Format Option

All 42 tools accept an optional `format` parameter that controls how structured data is returned:

| Value | Description |
|-------|-------------|
| `json` | **(default)** Standard JSON — best for programmatic consumption and MCP tool chaining. |
| `html` | Minimal HTML fragment (`<table>`, `<dl>`, `<pre>`) — designed for embedding in Teams Adaptive Cards, web chat, or Claude artifacts. No `<html>`/`<body>` wrappers. Elements carry CSS classes (`mcp-table`, `mcp-detail`, `mcp-raw`) for easy inline styling. |
| `md` | GitHub-Flavoured Markdown — GFM tables for arrays, bold key–value lists for objects. Ideal for chat UIs that render Markdown natively. |

**Example — request blob list as Markdown:**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "blob-list",
    "arguments": { "containerName": "my-data", "format": "md" }
  },
  "id": 3
}
```

**HTML output classes** (for CSS targeting):
- `.mcp-title` — `<h3>` section heading
- `.mcp-table` — `<table>` for array-of-objects
- `.mcp-detail` — `<dl>` for single-object key–value
- `.mcp-nested` — `<pre>` for nested JSON inside a detail list
- `.mcp-raw` — `<pre>` for primitives or non-object data

---

## Structured Error Model

All 42 tools return **structured error JSON** when an operation fails. Instead of plain-text error messages, every error response uses `isError: true` with a single text content item containing a JSON object. This makes errors machine-parseable for automated retry logic, error routing, and client-side handling.

### Error Response Shape

When a tool call fails, the MCP response looks like:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "isError": true,
    "content": [
      {
        "type": "text",
        "text": "{\"error\":{\"code\":\"not_found\",\"status\":404,\"azureCode\":\"BlobNotFound\",\"message\":\"BlobNotFound: The specified blob does not exist.\",\"retryable\":false}}"
      }
    ]
  }
}
```

Parse the `text` field as JSON to access the structured payload:

```json
{
  "error": {
    "code": "not_found",
    "status": 404,
    "azureCode": "BlobNotFound",
    "message": "BlobNotFound: The specified blob does not exist.",
    "retryable": false
  }
}
```

### Error Codes

Every error includes a `code` field from this fixed set:

| Code | HTTP Status | Description | Extra Fields |
|------|-------------|-------------|--------------|
| `not_found` | 404 | The requested resource (blob, container, queue, table, share) does not exist. | — |
| `already_exists` | 409 | The resource already exists (container, queue, table, share). | — |
| `lease_lost` | varies | A lease or pop receipt is invalid, missing, or mismatched. Retry after re-acquiring. | — |
| `immutable` | 409 | The blob is protected by an immutability policy or legal hold. | `immutableUntil` (ISO 8601, when available) |
| `archived` | 409 | The blob is in the Archive tier and must be rehydrated before access. | `archiveStatus` (e.g. `"rehydrate-pending-to-hot"`) |
| `too_large` | — | The payload exceeds the maximum allowed size. | `maxBytes` |
| `rate_limited` | 429 | Too many requests — back off and retry. | `retryAfterSeconds` |
| `invalid` | 400 | A parameter or request value is invalid. | `field` (the invalid parameter name) |
| `forbidden` | 403 | The request is not authorised for this operation. | — |
| `backend` | 5xx / null | An unexpected server-side or network error. | `azureCode`, `status` |

### Common Fields

| Field | Type | Description |
|-------|------|-------------|
| `code` | `string` | Error category from the fixed set above. |
| `status` | `number \| null` | HTTP status code from the Azure REST API, or `null` for non-HTTP errors. |
| `azureCode` | `string?` | The Azure-specific error code (e.g. `"ContainerNotFound"`, `"PopReceiptMismatch"`). |
| `message` | `string` | Human-readable message. Starts with the Azure code when known (e.g. `"BlobNotFound: ..."`). SAS signatures and sensitive parameters are automatically redacted. |
| `retryable` | `boolean` | `true` for `rate_limited` and `backend` with 5xx status. `false` for all other codes. |

### Handling Errors

```typescript
const response = await callTool("blob-read", { containerName: "docs", blobName: "missing.txt" });

if (response.isError) {
  const { error } = JSON.parse(response.content[0].text);

  switch (error.code) {
    case "not_found":
      console.log(`Resource not found: ${error.message}`);
      break;
    case "rate_limited":
      console.log(`Throttled — retry after ${error.retryAfterSeconds}s`);
      break;
    case "backend":
      if (error.retryable) {
        console.log("Transient failure — safe to retry");
      }
      break;
    default:
      console.log(`Error [${error.code}]: ${error.message}`);
  }
}
```

---

## Available Tools

### Blob Storage (13 tools)

| Tool | Description |
|------|-------------|
| `blob-container-create` | Create a blob container (idempotent). Use before uploading blobs to a new container. Use `util-to-container-name` to sanitise free-form text into a valid name. |
| `blob-container-delete` | **Destructive** — permanently delete a container and ALL blobs inside it. Verify with `blob-container-exists` first. |
| `blob-container-exists` | Check whether a container exists. Returns `{ exists: true/false }`. |
| `blob-list` | List blobs in a container, optionally filtered by virtual directory prefix or name prefix. Returns name, size, content type, etag, dates, and optional metadata. Set `includeVersions=true` to include blob version entries with `versionId` and `isCurrentVersion` fields. Use `pageSize` to control iterator page size. |
| `blob-create` | Upload or overwrite a blob (base64 content). MIME type is auto-detected from extension. Use `util-to-base64` to encode text first. Best for small/text files. |
| `blob-upload-from-url` | Upload a file by URL — the server fetches it server-side. **Ideal for large/binary files** (PDFs, images) that exceed LLM context limits. No base64 encoding needed. |
| `blob-head` | Get blob properties (metadata, content type, size, tier, immutability, legal hold) without downloading content. Supports version-specific lookups via `versionId`. Use to inspect a blob's state before reading, deleting, or changing its tier. |
| `blob-read` | Download blob content as base64, or set `returnUrl=true` to get a time-limited SAS URL instead. Use `util-from-base64` to decode text. Supports version-specific reads via `versionId` and partial reads via `maxBytes` (returns `truncated: true` when the blob is larger). |
| `blob-delete` | **Destructive** — permanently delete a blob and its snapshots. Supports version-specific deletion via `versionId`. Returns a structured `immutable` error if the blob has an immutability policy or legal hold. |
| `blob-set-metadata` | Replace all custom metadata on a blob. Include existing keys you want to keep — this is a full replacement. |
| `blob-set-tier` | Change a blob's access tier (Hot, Cool, or Archive). Use for lifecycle cost optimisation. Moving to Archive is **potentially destructive** — archived blobs must be rehydrated before reading, which can take hours. Supports version-specific tier changes via `versionId` and `rehydratePriority` (High or Standard). |
| `blob-get-sas-url` | Generate a time-limited SAS URL for a specific blob. Use to grant temporary access without exposing account keys. |
| `blob-get-container-sas` | Generate a time-limited SAS token for an entire container. Returns both the token and a ready-to-use connection string. |

### Queue Storage (8 tools)

| Tool | Description |
|------|-------------|
| `queue-create` | Create a queue (idempotent). Use before sending messages to a new queue. |
| `queue-delete` | **Destructive** — permanently delete a queue and ALL pending messages. Check queue properties via the `azure-queue:///queues/{queueName}/properties` resource first. |
| `queue-send-message` | Send a text message to a queue with optional TTL. For structured data, serialise as JSON string. |
| `queue-peek-messages` | Preview messages at the front of a queue WITHOUT removing them. Messages stay visible to other receivers. |
| `queue-receive-messages` | Receive and hide messages for processing. Call `queue-delete-message` after processing to permanently remove each message. |
| `queue-delete-message` | Permanently remove a processed message. Requires `messageId` + `popReceipt` from `queue-receive-messages`. |
| `queue-update-message` | Update a JSON message body with additive fields (state, progress, attempt, owner, details) and optionally renew the lease. Requires `messageId` + `popReceipt`. Message body must be a JSON object (max 64 KiB). |
| `queue-renew-lease` | Renew a message's visibility timeout (lease) without changing the body. Pass `messageText` from the receive response to preserve the body content. Requires `messageId` + `popReceipt`. |

### Table Storage (5 tools)

| Tool | Description |
|------|-------------|
| `table-create` | Create a table (idempotent). Use before upserting entities to a new table. |
| `table-delete` | **Destructive** — permanently delete a table and ALL entities. |
| `table-entity-upsert` | Insert or merge-update an entity. Pass `partitionKey`, `rowKey`, and a flat `entity` JSON object (`{"name": "Alice", "score": 95}`). Merge preserves existing properties not in the request. |
| `table-entity-query` | Query entities with an OData filter (e.g. `PartitionKey eq 'sales'`). Omit the filter to return all rows up to the limit. |
| `table-entity-delete` | **Destructive** — permanently delete a single entity by partition key + row key. |

### File Share (8 tools)

| Tool | Description |
|------|-------------|
| `fileshare-list-shares` | List all file shares with names and properties (quota, last modified). |
| `fileshare-create-share` | Create a file share (idempotent). Use before uploading files to a new share. |
| `fileshare-delete-share` | **Destructive** — permanently delete a share and ALL files/directories inside it. |
| `fileshare-create-directory` | Create a directory and any missing parents (idempotent). Or let `fileshare-upload-file` auto-create directories. |
| `fileshare-delete-directory` | Delete a directory (must be empty — remove all contents first). Use the `azure-fileshare:///shares/{shareName}/files` resource to check. |
| `fileshare-upload-file` | Upload a file (base64 content). Auto-creates parent directories. Use `util-to-base64` to encode text first. |
| `fileshare-read-file` | Download file content as base64. Use `util-from-base64` to decode text. |
| `fileshare-delete-file` | **Destructive** — permanently delete a file from a share. |

### Utilities (8 tools)

| Tool | Description |
|------|-------------|
| `util-to-base64` | Encode text to base64. Use BEFORE `blob-create` or `fileshare-upload-file` for text content. |
| `util-from-base64` | Decode base64 to text. Use AFTER `blob-read` or `fileshare-read-file` for text content. Not suitable for binary files. |
| `util-refresh-blob-sas` | Generate a fresh SAS URL for a specific blob. Use to replace an expired SAS URL. |
| `util-refresh-container-sas` | Generate a fresh SAS token + connection string for a container. Use to replace an expired container SAS. |
| `util-get-content-type` | MIME type lookup by file name or extension. Returns `application/octet-stream` for unrecognised types. |
| `util-to-container-name` | Sanitise arbitrary text (email, URL, display name) into a valid Azure container name. Use BEFORE `blob-container-create`. |
| `util-get-upload-url` | Get the direct file upload endpoint URL, required fields, and usage examples. Use when uploading large or binary files that exceed base64/JSON-RPC limits. |
| `store-info` | Read-only snapshot of server runtime configuration, limits, disabled tools, auth mode, endpoints, and capabilities. Use to discover upload/body size limits and self-calibrate client behaviour. No secrets included. |

#### `store-info` — Server Configuration Discovery

The `store-info` tool returns a read-only snapshot of the server's runtime configuration and capabilities. It is intended for MCP clients to self-calibrate limits (e.g. max upload size, SAS expiry ceiling) and discover which tools are available without trial-and-error probing.

**Inputs:** `{ format?: "json" | "html" | "md" }` (default `"json"`)

**Output schema:**

```json
{
  "ok": true,
  "limits": {
    "maxUploadBytes": 5368709120,
    "maxJsonBodyBytes": 52428800,
    "sasMaxExpiryMinutes": 1440
  },
  "sas": {
    "protocol": "https"
  },
  "disabledTools": [],
  "auth": {
    "mode": "shared_key",
    "accountName": "mystorageaccount"
  },
  "endpoints": {
    "blobServiceUrl": "https://mystorageaccount.blob.core.windows.net"
  },
  "capabilities": {
    "versions": null,
    "archiveTier": null,
    "maxContainerConcurrency": 4
  }
}
```

| Field | Description |
|-------|-------------|
| `limits.maxUploadBytes` | Maximum file size for `POST /upload` (env: `MAX_UPLOAD_BYTES`, default 5 GiB). |
| `limits.maxJsonBodyBytes` | Maximum JSON body size for `/mcp` (env: `MAX_JSON_BODY_BYTES`, default 50 MiB). |
| `limits.sasMaxExpiryMinutes` | Ceiling for SAS token lifetime (env: `SAS_MAX_EXPIRY_MINUTES`, default 1440). |
| `sas.protocol` | SAS protocol: `"https"` or `"https,http"` (env: `SAS_PROTOCOL`). |
| `disabledTools` | Canonical (lowercase) list of tools disabled via `DISABLED_TOOLS`. |
| `auth.mode` | Authentication mode: `"shared_key"`, `"managed_identity"`, or `"dual"`. |
| `auth.accountName` | Azure Storage account name. |
| `endpoints.blobServiceUrl` | Base URL for blob service operations (respects Azurite overrides). |
| `capabilities.versions` | `null` (unknown); `true`/`false` if blob versioning support is detected. |
| `capabilities.archiveTier` | `null` (unknown); `true`/`false` if Archive tier operations are permitted. |
| `capabilities.maxContainerConcurrency` | Indicative concurrency for upload streaming (default 4). Not a strict guarantee. |

> **Security:** No secrets, keys, SAS tokens, or connection strings are included in the output.

### MCP Resources (12 resources)

Resources provide **read-only, URI-addressable** access to storage data. Unlike tools (which are actions), resources allow agents to directly attach storage data as LLM context without invoking a tool call. Resources complement the tools above — use resources for reading/browsing and tools for mutations.

#### Blob Storage Resources (4)

| Resource URI | Description |
|---|---|
| `azure-blob:///containers` | List all blob containers. Starting point to discover containers before reading blobs. Returns JSON with name and index. |
| `azure-blob:///containers/{containerName}/properties` | Container properties and metadata (lease status, immutability policy, legal hold). |
| `azure-blob:///containers/{containerName}/blobs` | List all blobs in a container with name, size, content type, and last-modified date. |
| `azure-blob:///containers/{containerName}/blobs/{blobName}` | Read blob content. Text blobs returned as UTF-8 text; binary blobs as base64. |

#### File Share Resources (4)

| Resource URI | Description |
|---|---|
| `azure-fileshare:///shares` | List all file shares. Starting point to discover shares before browsing directories. Returns JSON with name and index. |
| `azure-fileshare:///shares/{shareName}/files/{directoryPath}` | List files and subdirectories in a directory. Use empty directoryPath for root. Returns name, type, size. |
| `azure-fileshare:///shares/{shareName}/file/{directoryPath}/{fileName}` | Read file content. Text files returned as UTF-8 text; binary files as base64. |
| `azure-fileshare:///shares/{shareName}/properties/{directoryPath}/{fileName}` | File properties (size, content type, timestamps, metadata) without downloading content. |

#### Queue Storage Resources (2)

| Resource URI | Description |
|---|---|
| `azure-queue:///queues` | List all queues. Messages are accessed via tools (not resources) because receiving has side effects. |
| `azure-queue:///queues/{queueName}/properties` | Queue properties including approximate message count and metadata. |

#### Table Storage Resources (2)

| Resource URI | Description |
|---|---|
| `azure-table:///tables` | List all tables. Use before querying or upserting entities via tools. |
| `azure-table:///tables/{tableName}/entities/{partitionKey}/{rowKey}` | Get a single entity by composite key. Faster than a query when you know the exact key. |

---

## Uploading Large / Binary Files

MCP uses JSON-RPC, so all tool parameters are JSON strings. For small files, `blob-create` works well with base64 encoding. But for large or binary files (PDFs, images, videos), base64 encoding is impractical — especially when the LLM context window can't hold a multi-MB encoded string.

Three approaches solve this:

### Option 1 — `blob-upload-from-url` MCP tool (recommended for AI agents)

Give the server a URL; it fetches and uploads server-side. No base64 needed — the LLM only passes a short URL string:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "blob-upload-from-url",
    "arguments": {
      "containerName": "documents",
      "blobName": "reports/annual-report.pdf",
      "sourceUrl": "https://example.com/files/annual-report.pdf"
    }
  },
  "id": 1
}
```

The URL must be publicly accessible or include authentication (e.g. a SAS URL from another storage account). The server detects the MIME type from the HTTP response headers.

### Option 2 — `POST /upload` REST endpoint (recommended for scripts / CI / clients)

Upload files directly via standard multipart form-data — the same format used by HTML file inputs and `curl`. No MCP or JSON-RPC involved:

```bash
# Upload a PDF
curl -X POST https://<your-app>.azurecontainerapps.io/upload \
  -H "X-API-Key: <your-api-key>" \
  -F "file=@./annual-report.pdf" \
  -F "containerName=documents" \
  -F "blobName=reports/annual-report.pdf"

# Upload with metadata
curl -X POST https://<your-app>.azurecontainerapps.io/upload \
  -H "X-API-Key: <your-api-key>" \
  -F "file=@./photo.jpg" \
  -F "containerName=images" \
  -F "blobName=photos/vacation.jpg" \
  -F 'metadata={"photographer":"Alice","location":"Paris"}'
```

**Python example:**
```python
import requests

response = requests.post(
    "https://<your-app>.azurecontainerapps.io/upload",
    headers={"X-API-Key": "<your-api-key>"},
    files={"file": open("report.pdf", "rb")},
    data={
        "containerName": "documents",
        "blobName": "reports/report.pdf",
    },
)
print(response.json())
# → {"success": true, "blobName": "reports/report.pdf", "contentType": "application/pdf", "size": 2048576, ...}
```

| Field | Required | Description |
|-------|----------|-------------|
| `file` | **Yes** | The file to upload (multipart form field) |
| `containerName` | **Yes** | Target blob container |
| `blobName` | No | Blob name (defaults to the uploaded filename) |
| `metadata` | No | JSON string of key-value metadata |

**Streaming:** The `/upload` endpoint streams files directly to Azure Blob Storage without buffering the entire file in memory or on disk. This keeps server memory bounded even for multi-GB uploads. Oversized files (exceeding `MAX_UPLOAD_BYTES`, default 5 GiB) are rejected with HTTP 413 and a structured JSON body containing `code: "too_large"` and `maxBytes`.

**Limits:** Default 5 GiB per upload (configurable via `MAX_UPLOAD_BYTES`). For larger files, use Option 3 below.

### Option 3 — SAS URL direct upload (for very large files)

Use `blob-get-container-sas` to generate a write-enabled SAS URL, then upload directly to Azure Storage from any HTTP client — bypassing the MCP server entirely:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "blob-get-container-sas",
    "arguments": {
      "containerName": "documents",
      "permissions": "rwl",
      "expiryHours": 1
    }
  },
  "id": 1
}
```

Then upload directly to Azure Blob Storage using the SAS token from the response — no size limits from the MCP server.

---

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- An **Azure Storage Account** with access keys
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/) + [Azure Developer CLI (`azd`)](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/) for deployment

---

## Quick Start (Local Development)

### 1. Clone and install

```bash
git clone https://github.com/<your-username>/mcp-azure-storage.git
cd mcp-azure-storage
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
PORT=3000
MCP_API_KEY=your-secret-api-key-here

AZURE_STORAGE_ACCOUNT_NAME=yourstorageaccount
AZURE_STORAGE_ACCOUNT_KEY=youraccountkey
```

> **Finding your storage account key:**
> Azure Portal → Storage Account → **Access keys**, or via CLI:
> ```bash
> az storage account keys list --account-name yourstorageaccount --query "[0].value" -o tsv
> ```

### 3. Run the dev server

```bash
npm run dev
```

You should see:

```
🚀 MCP Azure Storage Server v1.0.0
   MCP endpoint : http://localhost:3000/mcp
   Health check : http://localhost:3000/health
   Modes        : Stateful (session) + Stateless (one-shot)
   API key auth : ✅ ENABLED
   CORS         : ✅ ENABLED
   Rate limit   : 300 req / 15 min per IP
   Session TTL  : 30 minutes
   Max sessions : 100
   SSE keepalive: 30s
   JSON limit   : 50mb
```

### 4. Verify

```bash
curl http://localhost:3000/health
# → {"status":"healthy"}
```

---

## Testing with Postman

All requests go to `POST http://localhost:3000/mcp` with headers:

```
Content-Type: application/json
Accept: application/json, text/event-stream
X-API-Key: <your-api-key>
```

> **Important:** The MCP SDK requires `Accept: application/json, text/event-stream` exactly — `*/*` will not work.

### Stateless mode (recommended for HTTP testing)

Skip `initialize` entirely — send tool calls directly:

**List tools:**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/list",
  "params": {},
  "id": 1
}
```

**Call a tool:**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "blob-list",
    "arguments": { "containerName": "my-container" }
  },
  "id": 2
}
```

**List resources:**
```json
{
  "jsonrpc": "2.0",
  "method": "resources/list",
  "params": {},
  "id": 3
}
```

**Read a resource:**
```json
{
  "jsonrpc": "2.0",
  "method": "resources/read",
  "params": {
    "uri": "azure-blob:///containers"
  },
  "id": 4
}
```

### Stateful mode (for MCP clients)

Send `initialize` first — the response includes a `Mcp-Session-Id` header. Pass it on all subsequent requests:

```
Mcp-Session-Id: <session-id-from-init-response>
```

---

## Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Set transport to **Streamable HTTP**, URL to `http://localhost:3000/mcp`, and add header `X-API-Key: <your-key>`.

---

## Connecting to AI Assistants

### RooCode (VS Code)

RooCode supports Streamable HTTP transport natively. Add to your VS Code MCP settings (`.vscode/mcp.json` or global settings):

**Local dev server:**
```json
{
  "mcpServers": {
    "azure-storage": {
      "url": "http://localhost:3000/mcp",
      "transport": "streamable-http",
      "headers": {
        "X-API-Key": "<your-api-key>"
      }
    }
  }
}
```

**Remote (Azure-deployed) server:**
```json
{
  "mcpServers": {
    "azure-storage": {
      "url": "https://<your-app>.azurecontainerapps.io/mcp",
      "transport": "streamable-http",
      "headers": {
        "X-API-Key": "<your-production-api-key>"
      }
    }
  }
}
```

### Claude Desktop

Claude Desktop does not natively support remote HTTP MCP servers — it only connects to local stdio processes. To bridge the gap, use [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), which acts as a local stdio-to-HTTP proxy.

**Prerequisites:** [Node.js](https://nodejs.org/) 20+ must be installed.

**Setup:**

1. Open Claude Desktop → **Settings** → **Developer** → **Local MCP Servers** → **Edit Config**
2. Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-azure-storage": {
      "command": "C:\\PROGRA~1\\nodejs\\npx.cmd",
      "args": [
        "-y",
        "mcp-remote",
        "https://<your-app>.azurecontainerapps.io/mcp",
        "--header",
        "X-API-Key: <your-production-api-key>",
        "--transport",
        "http-first"
      ]
    }
  }
}
```

> **macOS / Linux** — replace `"command"` with `"npx"` (assuming Node.js is on your PATH):
> ```json
> {
>   "mcpServers": {
>     "mcp-azure-storage": {
>       "command": "npx",
>       "args": [
>         "-y",
>         "mcp-remote",
>         "https://<your-app>.azurecontainerapps.io/mcp",
>         "--header",
>         "X-API-Key: <your-production-api-key>",
>         "--transport",
>         "http-first"
>       ]
>     }
>   }
> }
> ```

3. Restart Claude Desktop. The MCP server should appear in the tools list.

**How it works:** `mcp-remote` runs as a local stdio process that Claude Desktop spawns. It forwards all MCP JSON-RPC messages over HTTP to your remote Azure endpoint, passing the `X-API-Key` header for authentication. The `--transport http-first` flag tells it to prefer Streamable HTTP transport (matching this server's transport).

**For local development**, point at `http://localhost:3000/mcp` instead of the Azure URL:

```json
{
  "mcpServers": {
    "mcp-azure-storage": {
      "command": "C:\\PROGRA~1\\nodejs\\npx.cmd",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:3000/mcp",
        "--header",
        "X-API-Key: <your-local-api-key>",
        "--transport",
        "http-first"
      ]
    }
  }
}
```

---

## Deploy to Azure

### Quick Deploy (Recommended)

The [`deploy_to_azure.ps1`](deploy_to_azure.ps1) script automates the entire deployment process. It reads your `.env` file, syncs the relevant variables into the azd environment, and runs `azd up` — so you only need to maintain **one `.env` file** for both local development and Azure deployment.

```powershell
# Full provision + deploy (reads .env, syncs to azd, runs azd up)
.\deploy_to_azure.ps1

# Code-only redeploy — faster, skips Bicep infrastructure provisioning
.\deploy_to_azure.ps1 -SkipProvision

# Use a different env file
.\deploy_to_azure.ps1 -EnvFile ".env.production"

# Enable one-way lifecycle policy (Cold after 15d, Archive after 90d)
.\deploy_to_azure.ps1 -LifecyclePolicy one-way

# Enable smart lifecycle policy (Cool after 30d inactivity, auto-reheat on access)
.\deploy_to_azure.ps1 -LifecyclePolicy smart
```

| Flag | Description |
|------|-------------|
| `-EnvFile <path>` | Path to the `.env` file. Defaults to `.env` in the script directory. |
| `-SkipProvision` | Runs `azd deploy` instead of `azd up` (skips Bicep provisioning). Use when only code has changed. |
| `-LifecyclePolicy <mode>` | Controls automatic blob access-tier transitions on new storage accounts. Values: `none` (default), `one-way`, `smart`. See below. |

**What the script does:**
1. Parses your `.env` file for uncommented `KEY=VALUE` lines
2. Syncs `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_ACCOUNT_KEY`, and `MCP_API_KEY` into the active azd environment
3. Sets optional infrastructure flags (e.g. lifecycle policy)
4. Shows a deployment summary with confirmation prompt
5. Runs `azd up` (or `azd deploy` with `-SkipProvision`)
6. Displays the MCP endpoint URL on success

#### Storage Lifecycle Policy

The `-LifecyclePolicy` parameter controls automatic blob access-tier transitions that reduce storage costs without any application changes. Three modes are available:

| Mode | Description |
|------|-------------|
| `none` | **(default)** No lifecycle rules. All blobs stay in Hot tier. |
| `one-way` | Blobs move to cheaper tiers based on modification date and never automatically return. Cold after 15 days, Archive after 90 days. Archived blobs must be manually rehydrated (via the `blob-set-tier` tool) before they can be read. |
| `smart` | Blobs move to Cool tier after 30 days of inactivity (no reads), then automatically promote back to Hot when accessed. Enables access-time tracking on the storage account. Does **not** use Archive tier (Azure cannot auto-rehydrate archived blobs). |

##### Mode details

**`one-way` mode rules:**

| Rule | Scope | Action |
|------|-------|--------|
| `cold-after-15-days` | All block blobs | Move to **Cold** tier after 15 days of no modification |
| `archive-after-90-days` | All block blobs | Move to **Archive** tier after 90 days of no modification |

**`smart` mode rules:**

| Rule | Scope | Action |
|------|-------|--------|
| `cool-after-30-days-inactive` | All block blobs | Move to **Cool** tier after 30 days with no access |
| _(automatic)_ | Cool blobs | Auto-promote back to **Hot** when accessed (`enableAutoTierToHotFromCool`) |

> **Why no Archive in smart mode?** Azure lifecycle management can automatically move blobs *into* Archive tier, but it cannot automatically rehydrate them when accessed. Rehydration is a manual, asynchronous operation that takes up to 15 hours (Standard priority) or under 1 hour (High priority). Smart mode uses only Hot/Cool tiers where automatic promotion is supported.

**Notes:**
- **Off by default** (`none`) -- no lifecycle rules are provisioned
- **Only applies to new storage accounts** provisioned by Bicep -- has no effect when using BYOSA (bring-your-own storage account)
- To change modes, pass the new `-LifecyclePolicy` value and run `azd provision`; the next deployment will replace the lifecycle policy
- Day thresholds can be customised by editing [`infra/main.bicep`](infra/main.bicep)

> **Prerequisites:** You must have run `az login`, `azd auth login`, and `azd init` at least once before using the script. See the manual steps below if this is your first deployment.

---

### Manual Deployment

#### 1. Login

```bash
az login
azd auth login
```

#### 2. Initialize (first time only)

```bash
azd init
```

This prompts you for an **environment name** (e.g. `mcp-azure-storage-dev`), **Azure subscription**, and **location**. It creates a `.azure/<env-name>/.env` file to store configuration for subsequent commands.

#### 3. Set deployment variables

azd stores environment variables in `.azure/<env-name>/.env`. Some are set automatically by `azd init`; others need to be set manually. See [`.azure.env.example`](.azure.env.example) for the full template with descriptions.

**Required — set before first deploy:**

```bash
azd env set MCP_API_KEY "your-strong-secret-key-here"
```

Or generate a random key:

**macOS / Linux:**
```bash
azd env set MCP_API_KEY "$(openssl rand -base64 24)"
```

**Windows (PowerShell):**
```powershell
azd env set MCP_API_KEY ([Convert]::ToBase64String((1..24 | ForEach-Object { Get-Random -Max 256 }) -as [byte[]]))
```

**Optional — use an existing Storage Account (BYOSA):**

By default, `azd provision` creates a **new empty** Storage Account. To connect to an **existing** storage account (e.g. one that already contains your data), set both variables before deploying:

```bash
azd env set AZURE_STORAGE_ACCOUNT_NAME "yourstorageaccount"
azd env set AZURE_STORAGE_ACCOUNT_KEY "youraccountkey"
```

> **Finding your storage account key:**
> ```bash
> az storage account keys list --account-name yourstorageaccount --query "[0].value" -o tsv
> ```

When both are set:
- No new Storage Account is created by Bicep
- Storage RBAC role assignments are skipped
- The Container App connects directly using the provided credentials
- The existing account can be in any subscription, resource group, or region

Leave them **unset** to have Bicep provision a new storage account automatically.

**Auto-populated after `azd init`** (no action needed):

| Variable | Description |
|----------|-------------|
| `AZURE_ENV_NAME` | Environment name chosen during `azd init` |
| `AZURE_LOCATION` | Azure region chosen during `azd init` |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription chosen during `azd init` |

**Auto-populated after `azd provision`** (no action needed):

| Variable | Description |
|----------|-------------|
| `AZURE_CONTAINER_REGISTRY_ENDPOINT` | ACR login server (Bicep output) |
| `mcpEndpoint` | Full MCP endpoint URL (Bicep output) |
| `storageAccountName` | Provisioned storage account name (Bicep output) |

**Auto-populated after `azd deploy`** (no action needed):

| Variable | Description |
|----------|-------------|
| `SERVICE_MCP_SERVER_IMAGE_NAME` | Docker image pushed to ACR |
| `SERVICE_MCP_SERVER_RESOURCE_EXISTS` | Whether the Container App resource exists |

> **Tip:** View all current environment values with `azd env get-values`. To start fresh after a teardown, delete the `.azure/<env-name>/` directory or run `azd env new <new-name>`.

> **Multiple environments (dev, test, prod):** `azd` supports named environments out of the box — each with its own subscription, region, and secrets. See the **[Multi-Environment Deployment Guide](ENVIRONMENTS.md)** for step-by-step instructions on creating, switching, and deploying to separate dev and test environments.

#### 4. Deploy

##### Option A — Single command

```bash
azd up
```

##### Option B — Step-by-step (provision then deploy separately)

If `azd up` fails, times out, or you need more control, run the two phases individually:

```bash
# Step 1: Provision infrastructure (Bicep → Resource Group, ACR, Storage, Container App, RBAC)
azd provision

# Step 2: Build Docker image, push to ACR, and update the Container App
azd deploy
```

> **Tip:** If only infrastructure changed (edited `infra/main.bicep`), run `azd provision` alone. If only application code changed, run `azd deploy` alone. Running both in sequence is equivalent to `azd up`.

Both options provision via Bicep:
- **Resource Group** with Container Apps Environment
- **Azure Container Registry** (Basic SKU, admin-user disabled)
- **User-Assigned Managed Identity** — created before the Container App to break the ACR pull circular dependency
- **Azure Storage Account** (Standard_LRS, TLS 1.2)
- **Azure Container App** with auto-HTTPS on `*.azurecontainerapps.io`, sticky sessions, placeholder image on first provision
- **RBAC** — AcrPull + Blob, Queue, and Table Data Contributor roles (all assigned before the Container App is created)
- **Secrets** — MCP_API_KEY and Storage Account Key injected securely

#### 5. Test the deployed endpoint

```bash
curl -X POST https://<your-app>.azurecontainerapps.io/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-API-Key: <your-production-key>" \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'
```

#### 6. Check deployment status

Use `azd show` to view the current state of all provisioned resources and service endpoints:

```bash
azd show
```

To see detailed provisioning output or diagnose issues, review the last deployment operation:

```bash
azd provision --preview
```

You can also check the Container App's live status directly via the Azure CLI:

```bash
az containerapp show \
  --name <your-app-name> \
  --resource-group <your-resource-group> \
  --query "{status:properties.runningStatus, fqdn:properties.configuration.ingress.fqdn}" \
  -o table
```

#### 7. Redeploy after code changes

After modifying source code, rebuild and redeploy the container with:

```bash
azd deploy
```

This rebuilds the Docker image, pushes it to the Azure Container Registry, and updates the Container App — without re-provisioning infrastructure.

If you have also changed the Bicep infrastructure files (e.g. `infra/main.bicep`), run the full provision-and-deploy cycle instead:

```bash
azd up
```

#### 8. Tear down the deployment

To delete **all** Azure resources created by `azd up` (Resource Group, Container App, Storage Account, Container Registry, etc.):

```bash
azd down
```

Add the `--purge` flag to also purge any soft-deleted resources (e.g. Key Vault) so the names can be reused immediately:

```bash
azd down --purge
```

> **Warning:** `azd down` is destructive. All data in the provisioned Storage Account will be permanently lost.

---

## OpenTelemetry Monitoring

Version 1.2 adds opt-in OpenTelemetry observability. When enabled, traces, metrics, and logs are exported to Azure Monitor / Application Insights via an OTel Collector sidecar.

**Default behaviour is unchanged** -- OTel activates only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Without it, the server runs exactly as before with zero overhead.

### Architecture

```
MCP Server  --OTLP/HTTP-->  OTel Collector  --azure_monitor-->  Application Insights
(Express)                   (sidecar)                           (Log Analytics Workspace)
```

All three signals (traces, metrics, logs) land in a single Application Insights resource, correlated by `operation_Id`.

### Enabling on Azure

```powershell
.\deploy_to_azure.ps1 -EnableOTel
```

This provisions Application Insights, builds the OTel Collector sidecar image, and deploys both containers to Azure Container Apps.

### Telemetry Levels

Control data volume and cost via `OTEL_TELEMETRY_LEVEL`:

| Level | Traces | Metrics | Logs | Estimated cost |
|-------|--------|---------|------|----------------|
| `off` | None | None | None | Zero |
| `basic` (default) | 10% sampled | 60s interval | WARN+ only | ~$1-4/mo |
| `detailed` | 100% | 15s interval | INFO+ | ~$5-20/mo |
| `full` | All + internal | 5s interval | All incl. DEBUG | ~$20-100+/mo |

Cost depends on request volume. The first 5 GB/month of Application Insights data ingestion is free.

### Dashboard

When OTel is enabled, an Azure Workbook is deployed with four tabs:

- **Overview** -- Request rate, error rate, latency percentiles (P50/P90/P99)
- **Tools** -- Per-tool call distribution, latency breakdown, error rates
- **Data Volume** -- Blob payload sizes, daily data transfer, request counts by tool
- **Logs** -- Severity distribution, correlated log stream

### Alert Rules

Two warning-level alert rules are created (no notifications by default):

- **High Error Rate** -- Fires when error rate exceeds 10% over two consecutive 5-minute windows
- **Latency Degradation** -- Fires when P95 latency exceeds 3 standard deviations above the 1-hour baseline

### Local Development

For local OTel testing, run a collector container and set the endpoint:

```bash
# Start collector (requires otel-collector-config.azure.yaml and a connection string)
docker run -d --name otel-collector \
  -p 4318:4318 \
  -e APPLICATIONINSIGHTS_CONNECTION_STRING="your-connection-string" \
  -e OTEL_LOG_MIN_SEVERITY=13 \
  -e OTEL_DEPLOYMENT_ENV=dev \
  -v $(pwd)/otel/otel-collector-config.azure.yaml:/etc/otelcol-contrib/config.yaml:ro \
  otel/opentelemetry-collector-contrib:0.127.0

# Set the endpoint in .env
echo "OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318" >> .env
```

### Standalone Monitoring Setup

To provision Azure Monitor resources independently of the main deployment:

```powershell
.\scripts\setup-monitoring.ps1 -ResourceGroup "my-rg" -AppInsightsName "my-appi"
```

To verify telemetry is arriving:

```powershell
.\scripts\setup-monitoring.ps1 -ResourceGroup "my-rg" -AppInsightsName "my-appi" -VerifyOnly
```

---

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Server listen port |
| `MCP_API_KEY` | **Yes** | — | API key for client authentication |
| `AZURE_STORAGE_ACCOUNT_NAME` | **Yes** | — | Azure Storage account name |
| `AZURE_STORAGE_ACCOUNT_KEY` | **Yes** | — | Azure Storage account key |
| `CORS_ENABLED` | No | `true` | Enable CORS headers for browser-based clients (MCP Inspector, web chat). Set `false` in production if only non-browser clients connect. |
| `SAS_EXPIRY_HOURS` | No | `24` | Default SAS token expiry (hours) |
| `SAS_DEFAULT_PERMISSIONS` | No | `rl` | Default SAS permissions |
| `SAS_MAX_EXPIRY_MINUTES` | No | `1440` | Maximum allowed SAS token lifetime in minutes (ceiling). Requests for `expiryMinutes` (or `expiryHours` converted to minutes) exceeding this value receive a structured `"invalid"` error with `field: "expiryMinutes"` or `field: "expiryHours"`. Default: 1440 (24 hours). Set lower (e.g. `60`) for tighter security. |
| `SAS_PROTOCOL` | No | `https` | Controls the `spr` (signed protocol) in generated SAS tokens. `"https"` (default) — HTTPS-only, recommended for production. `"https,http"` — allow both; required for **Azurite** / local emulator which serves over plain HTTP. Case-insensitive; `"http,https"` is also accepted. |
| `RATE_LIMIT_WINDOW_SECONDS` | No | `900` | Rate limit window in seconds (overrides `RATE_LIMIT_WINDOW_MINUTES` when set) |
| `RATE_LIMIT_MCP_MAX` | No | `3000` | Max requests per window for `/mcp` (JSON-RPC) per identity |
| `RATE_LIMIT_UPLOAD_MAX` | No | `600` | Max requests per window for `/upload` (multipart) per identity |
| `RATE_LIMIT_WINDOW_MINUTES` | No | `15` | Legacy rate limit window (minutes). Used when `RATE_LIMIT_WINDOW_SECONDS` is unset |
| `RATE_LIMIT_MAX_REQUESTS` | No | `300` | Legacy max requests per window. Used for both endpoints when specific `*_MAX` vars are unset |
| `TRUST_PROXY_HOPS` | No | `1` | Number of trusted reverse proxy hops for X-Forwarded-For resolution. Set `2` if behind both a CDN and Container Apps |
| `MAX_SESSIONS` | No | `100` | Maximum concurrent stateful MCP sessions (returns 503 when full) |
| `SESSION_RETRY_AFTER_SECONDS` | No | `30` | Retry hint (seconds) returned in 503 session-capacity errors |
| `SSE_KEEPALIVE_INTERVAL_MS` | No | `30000` | Interval (ms) between SSE keepalive heartbeats. Prevents Azure reverse proxy from killing idle SSE connections (~240s timeout). |
| `MAX_UPLOAD_BYTES` | No | `5368709120` | Hard byte limit for streaming multipart uploads via `/upload`. Default: 5 GiB. Files exceeding this are rejected with HTTP 413 (`code: "too_large"`). |
| `MAX_JSON_BODY_BYTES` | No | `52428800` | Hard byte limit for JSON request bodies on `/mcp`. Default: 50 MiB. Controls `express.json({ limit })`. Oversized JSON bodies return HTTP 413. |
| `MAX_QUEUE_VISIBILITY_SECONDS` | No | `3600` | Maximum allowed visibility timeout (lease duration) for `queue-update-message` and `queue-renew-lease`. Default: 3600 (1 hour). Azure Queue Storage supports up to 7 days, but this server-side cap prevents accidentally setting very long leases. |
| `DISABLED_TOOLS` | No | _(empty)_ | Comma-separated list of tool names to disable at runtime. Disabled tools are **omitted from `tools/list`** and return a structured `"forbidden"` error (code `"forbidden"`, `data.reason: "disabled_tool"`) when invoked via `tools/call`. Values are **case-insensitive** and whitespace is trimmed. Unknown names trigger a startup warning but do not prevent the server from starting. Example: `DISABLED_TOOLS=blob-delete,fileshare-delete-share,table-delete,queue-delete`. |

> **Note:** The Azure deployment uses `minReplicas: 1` to keep at least one replica always running, ensuring consistent response times and no cold-start connection drops. The Container App auto-scales up to 5 replicas under load (HTTP concurrency threshold: 20 requests). If you want to reduce costs in a non-production environment, you can set `minReplicas: 0` in [`infra/main.bicep`](infra/main.bicep:342), but be aware that scale-to-zero causes 10–30 second cold starts that may time out HTTP clients like Postman.

### Connection Stability (Azure Container Apps)

The deployment includes three mechanisms to ensure reliable connections:

1. **Sticky sessions** — The Bicep ingress configures `stickySessions.affinity: 'sticky'` with `activeRevisionsMode: 'Single'` (required by Azure for sticky session support) so all requests from the same client are routed to the same replica. Without this, stateful MCP sessions (stored in-memory) would break when the load balancer routes a request to a different replica.

2. **SSE keepalive heartbeats** — Azure Container Apps has a ~240 second idle timeout on ingress connections. SSE streams (used by stateful MCP sessions for server-initiated notifications) that go idle would be silently killed by the reverse proxy. The server sends periodic SSE comments (`: keepalive`) every 30 seconds to keep the connection alive. Configure via `SSE_KEEPALIVE_INTERVAL_MS`.

3. **Stale session detection** — If a client sends a `Mcp-Session-Id` that no longer exists (e.g. after server restart, scale event, or TTL expiry), the server returns a clear `404` error instead of silently falling through to stateless mode. Clients should handle this by sending a new `initialize` request.

---

## Security

- **Fail-closed authentication** — all requests are rejected if `MCP_API_KEY` is not set
- **Constant-time comparison** — API key validation uses `crypto.timingSafeEqual` to prevent timing attacks
- **No query-param auth** — API keys are only accepted via headers (not URLs that leak to logs)
- **SSRF protection** — `blob-upload-from-url` validates URLs before fetching: blocks loopback, link-local (Azure IMDS 169.254.169.254), private RFC 1918 ranges, non-HTTP schemes, and open redirects (`redirect: "error"`)
- **Streaming uploads** — `POST /upload` streams directly to Azure Blob Storage via busboy + `uploadStream` (no temp files, no full-file buffering). Capped at `MAX_UPLOAD_BYTES` (default 5 GiB); oversized files return 413 with `code: "too_large"`. Rate-limited by the same per-identity limiter as `/mcp`
- **Helmet** — sets security headers (HSTS, X-Content-Type-Options, X-Frame-Options, etc.)
- **Rate limiting** — per-IP request throttling on both `/mcp` and `/upload` endpoints
- **Session TTL** — idle sessions are automatically evicted after 30 minutes
- **Non-root Docker** — container runs as unprivileged `appuser`
- **User-assigned managed identity** — ACR pull + Storage RBAC with no circular dependency
- **Secrets in Bicep** — storage keys and API keys are injected as Container App secrets via `@secure()` parameters
- **`.env` gitignored** — credentials never enter version control

---

## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `npm run dev` | Start dev server with hot reload (`tsx watch`) |
| `build` | `npm run build` | Compile TypeScript to `dist/` |
| `start` | `npm run start` | Run compiled production build |
| `test` | `npm test` | Run unit tests (no Azure needed) |
| `test:watch` | `npm run test:watch` | Run tests in watch mode |
| `test:coverage` | `npm run test:coverage` | Run tests with v8 coverage report |
| `test:integration` | `npm run test:integration` | Run Azurite integration tests |
| `azd:dev` | `npm run azd:dev` | Provision + deploy to dev environment |
| `azd:dev:provision` | `npm run azd:dev:provision` | Provision dev infrastructure only |
| `azd:dev:deploy` | `npm run azd:dev:deploy` | Deploy app to dev only (skip provision) |
| `azd:test` | `npm run azd:test` | Provision + deploy to test environment |
| `azd:test:provision` | `npm run azd:test:provision` | Provision test infrastructure only |
| `azd:test:deploy` | `npm run azd:test:deploy` | Deploy app to test only (skip provision) |
| -- | `.\deploy_to_azure.ps1` | Reads `.env`, syncs vars to azd env, runs `azd up` (add `-SkipProvision` for code-only deploy, `-LifecyclePolicy one-way\|smart` for auto-tiering) |
| -- | `.\scripts\otel-verify.ps1` | Exercises all tool categories via MCP JSON-RPC to generate OTel telemetry (blob, queue, table, utility); includes error cases and cleanup. Use `-Endpoint` and `-ApiKey` or reads from azd env / `.env`. |

---

## Testing

### Unit Tests (312 tests, no Azure required)

Unit tests mock all Azure SDK modules and test through a stateless MCP HTTP endpoint using supertest. No Azure credentials or network access needed.

```bash
# Run all unit tests
npm test

# Watch mode
npm run test:watch

# With coverage report
npm run test:coverage
```

**Test coverage:** Config, API key middleware, rate limiting, disabled-tool gating, structured errors, all 42 tools across 5 modules, all 12 resources across 4 modules, format utility (JSON/HTML/MD).

### Integration Tests (Azurite)

Integration tests run against [Azurite](https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite), the official Azure Storage emulator. They perform real CRUD operations against Blob, Queue, and Table services.

#### 1. Start Azurite

```bash
docker compose -f docker-compose.azurite.yml up -d
```

#### 2. Run integration tests

```bash
npm run test:integration
```

This sets `TEST_INTEGRATION=1` and uses the Azurite well-known credentials from `.env.test`.

#### 3. Stop Azurite

```bash
docker compose -f docker-compose.azurite.yml down
```

### Running Integration Tests — Advanced Gating

Integration tests use environment-variable gates to control which test suites run. This keeps default CI fast while still allowing heavy or live-Azure tests on demand.

| Gate variable | Default | Effect |
|---------------|---------|--------|
| `TEST_INTEGRATION` | `0` (off) | Master gate — set to `1` to enable any integration test. `npm run test:integration` sets this automatically. |
| `TEST_UPLOAD_LARGE` | `0` (off) | Set to `1` to enable 150+ MiB streaming upload tests. Skipped by default to keep CI under 60 s. |
| `TEST_AZURE_LIVE` | `0` (off) | Set to `1` to enable tests that require a live Azure Storage account (not Azurite). Also implicitly enables large upload tests. |
| `TEST_UPLOAD_MB` | `150` | Size in MiB for the large upload test payload. Only used when `TEST_UPLOAD_LARGE=1` or `TEST_AZURE_LIVE=1`. |

**Azurite SAS protocol:** Azurite serves over plain HTTP, so SAS tokens generated with the default `SAS_PROTOCOL=https` will fail validation. Set `SAS_PROTOCOL=https,http` in your `.env.test` or test environment when running SAS-related integration tests against Azurite.

**Endpoint overrides:** Azurite uses non-standard URLs (`http://127.0.0.1:10000/<account>`). The integration test environment configures these via:

```env
AZURE_BLOB_SERVICE_URL=http://127.0.0.1:10000/devstoreaccount1
AZURE_QUEUE_SERVICE_URL=http://127.0.0.1:10001/devstoreaccount1
AZURE_TABLE_SERVICE_URL=http://127.0.0.1:10002/devstoreaccount1
```

These are already set in [`.env.test`](.env.test). For live Azure tests, unset these overrides so SDK clients connect to the real service endpoints.

**Example — run large upload tests locally:**

```bash
docker compose -f docker-compose.azurite.yml up -d
set TEST_INTEGRATION=1&& set TEST_UPLOAD_LARGE=1&& vitest run --config vitest.integration.config.ts
```

### CI / GitHub Actions

The [`.github/workflows/ci.yml`](.github/workflows/ci.yml) workflow runs on every push and PR to `main`:

1. **Unit tests** — Node 20 + 22 matrix, with coverage upload on Node 22
2. **Integration tests** — Azurite service container, Node 22, blob/queue/table CRUD

### Test Architecture

```
tests/
├── helpers/mcp-test-harness.ts   # createTestApp(), mcpPost(), SSE parsers
├── config.test.ts                # getStorageConfig singleton + env vars
├── middleware/api-key.test.ts    # Auth middleware (503/401/403/pass-through)
├── tools/                        # vi.mock Azure SDKs → test via MCP endpoint
│   ├── blob-tools.test.ts
│   ├── queue-tools.test.ts
│   ├── table-tools.test.ts
│   ├── fileshare-tools.test.ts
│   ├── utility-tools.test.ts
│   └── structured-errors.test.ts # Error mapping, SAS sanitisation, MCP integration
├── resources/                    # vi.hoisted + vi.mock for module-scope clients
│   ├── blob-resources.test.ts
│   ├── queue-resources.test.ts
│   ├── table-resources.test.ts
│   └── fileshare-resources.test.ts
└── integration/                  # Real CRUD against Azurite (gated by TEST_INTEGRATION)
    ├── blob-integration.test.ts    # Blob CRUD + head + set-tier + versioned reads
    ├── queue-integration.test.ts   # Queue CRUD + update-message + renew-lease
    ├── upload-integration.test.ts  # Streaming upload via POST /upload (large tests gated)
    └── table-integration.test.ts   # Table CRUD smoke test
```

---

## Docker

### Build locally

```bash
docker build -t mcp-azure-storage .
```

### Run locally

```bash
docker run -p 3000:3000 \
  -e MCP_API_KEY="your-key" \
  -e AZURE_STORAGE_ACCOUNT_NAME="youraccount" \
  -e AZURE_STORAGE_ACCOUNT_KEY="yourkey" \
  mcp-azure-storage
```

### Container Registry (ACR)

Push the Docker image directly to Azure Container Registry using the included scripts.

#### Prerequisites

- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) (`az`)
- [Docker](https://docs.docker.com/get-docker/)
- [Trivy](https://aquasecurity.github.io/trivy/) (optional — for vulnerability scanning)
- PowerShell 7+ (`pwsh`)

#### Setup

1. Set `ACR_NAME` in your `.env` file:
   ```
   ACR_NAME=your-acr-name
   ```

2. Create the registry (one-time):
   ```bash
   npm run acr:setup -- -ResourceGroup rg-mcp-storage
   ```
   Optional parameters: `-Location` (default: `uksouth`), `-Sku` (default: `Basic`)

#### Push Image

```bash
# Build, scan, and push with 'latest' tag
npm run acr:push

# Push with a specific tag
npm run acr:push:tag -- v1.0.0

# Skip Trivy scan
npm run acr:push -- -SkipScan

# Reuse existing local image (skip build)
npm run acr:push -- -SkipBuild
```

The push script will:
1. Login to ACR via Azure CLI
2. Build the Docker image (multi-stage, `production` target)
3. Run a Trivy vulnerability scan (CRITICAL severity — aborts on findings)
4. Push the image to `<acr-name>.azurecr.io/mcp-azure-storage:<tag>`

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -am 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

---

## License

See [LICENSE](LICENSE) for details.
