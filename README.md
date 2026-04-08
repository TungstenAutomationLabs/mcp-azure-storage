# MCP Azure Storage Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes **35 tools** and **12 resources** for managing Azure Storage — Blob, Queue, Table, and File Share — over a single HTTP endpoint. Designed for use with TotalAgility, AI assistants (Claude, RooCode, Copilot), Postman, MCP Inspector, and any MCP-compatible client.

Deploys to **Azure Container Apps** with automatic HTTPS, user-assigned managed identity, and Bicep infrastructure-as-code.

---

## Features

- **35 MCP tools** across 5 categories (Blob, Queue, Table, File Share, Utilities)
- **12 MCP resources** — read-only, URI-addressable data for LLM context (listings, content reads, properties)
- **Dual-mode transport** — stateful sessions for MCP clients + stateless one-shot for HTTP testing
- **API key authentication** with constant-time comparison (X-API-Key header or Bearer token)
- **Rate limiting** — configurable per-IP request limits
- **Security headers** via Helmet
- **Session TTL** — automatic cleanup of idle sessions (30 min)
- **SAS token generation** — blob and container-level shared access signatures
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
                      │      35 Tools (actions)   │    12 Resources (reads)   │
                      ├───────────────────────────┼───────────────────────────┤
                      │ Blob (10) │ Queue (6)     │ Blob (4)  │ Queue (2)    │
                      │ Table (5) │ FileShare (8) │ Table (2) │ FileShare (4)│
                      │ Utility (6)               │                          │
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
│   │   ├── blob-tools.ts      # 10 tools — container + blob CRUD, SAS, metadata
│   │   ├── queue-tools.ts     #  6 tools — queue CRUD + message operations
│   │   ├── table-tools.ts     #  5 tools — table CRUD + entity operations
│   │   ├── fileshare-tools.ts #  8 tools — share/directory/file operations
│   │   └── utility-tools.ts   #  6 tools — base64, SAS refresh, MIME lookup
│   └── utils/
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
│   │   ├── blob-tools.test.ts      #  9 tests — mock Azure Blob SDK
│   │   ├── queue-tools.test.ts     #  7 tests — mock Azure Queue SDK
│   │   ├── table-tools.test.ts     #  7 tests — mock Azure Tables SDK
│   │   ├── fileshare-tools.test.ts #  6 tests — mock Azure File Share SDK
│   │   └── utility-tools.test.ts   #  9 tests — base64, MIME, container name
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
├── .github/workflows/
│   └── ci.yml                 # GitHub Actions — unit + integration tests
├── docker-compose.azurite.yml # Azurite emulator for local integration tests
├── vitest.config.ts           # Unit test config (coverage, thresholds)
├── vitest.integration.config.ts # Integration test config (Azurite)
├── .env.test                  # Azurite well-known credentials for tests
├── Dockerfile                 # Multi-stage build, non-root user
├── .dockerignore              # Excludes .env, docs, infra from image
├── azure.yaml                 # Azure Developer CLI project definition
├── .azure.env.example         # Template for azd deployment environment variables
├── .env.example               # Template for local environment variables
├── .gitignore                 # Ignores .env, dist, node_modules, docs
├── tsconfig.json              # TypeScript configuration
├── package.json               # Dependencies and scripts
└── LICENSE                    # Project license
```

---

## Response Format Option

All 35 tools accept an optional `format` parameter that controls how structured data is returned:

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

## Available Tools

### Blob Storage (10 tools)

| Tool | Description |
|------|-------------|
| `blob-container-create` | Create a blob container (idempotent). Use before uploading blobs to a new container. Use `util-to-container-name` to sanitise free-form text into a valid name. |
| `blob-container-delete` | **Destructive** — permanently delete a container and ALL blobs inside it. Verify with `blob-container-exists` first. |
| `blob-container-exists` | Check whether a container exists. Returns `{ exists: true/false }`. |
| `blob-list` | List blobs in a container, optionally filtered by virtual directory prefix. Returns name, size, content type, dates, and optional metadata. |
| `blob-create` | Upload or overwrite a blob (base64 content). MIME type is auto-detected from extension. Use `util-to-base64` to encode text first. |
| `blob-read` | Download blob content as base64, or set `returnUrl=true` to get a time-limited SAS URL instead. Use `util-from-base64` to decode text. |
| `blob-delete` | **Destructive** — permanently delete a blob and its snapshots. |
| `blob-set-metadata` | Replace all custom metadata on a blob. Include existing keys you want to keep — this is a full replacement. |
| `blob-get-sas-url` | Generate a time-limited SAS URL for a specific blob. Use to grant temporary access without exposing account keys. |
| `blob-get-container-sas` | Generate a time-limited SAS token for an entire container. Returns both the token and a ready-to-use connection string. |

### Queue Storage (6 tools)

| Tool | Description |
|------|-------------|
| `queue-create` | Create a queue (idempotent). Use before sending messages to a new queue. |
| `queue-delete` | **Destructive** — permanently delete a queue and ALL pending messages. Check queue properties via the `azure-queue:///queues/{queueName}/properties` resource first. |
| `queue-send-message` | Send a text message to a queue with optional TTL. For structured data, serialise as JSON string. |
| `queue-peek-messages` | Preview messages at the front of a queue WITHOUT removing them. Messages stay visible to other receivers. |
| `queue-receive-messages` | Receive and hide messages for processing. Call `queue-delete-message` after processing to permanently remove each message. |
| `queue-delete-message` | Permanently remove a processed message. Requires `messageId` + `popReceipt` from `queue-receive-messages`. |

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

### Utilities (6 tools)

| Tool | Description |
|------|-------------|
| `util-to-base64` | Encode text to base64. Use BEFORE `blob-create` or `fileshare-upload-file` for text content. |
| `util-from-base64` | Decode base64 to text. Use AFTER `blob-read` or `fileshare-read-file` for text content. Not suitable for binary files. |
| `util-refresh-blob-sas` | Generate a fresh SAS URL for a specific blob. Use to replace an expired SAS URL. |
| `util-refresh-container-sas` | Generate a fresh SAS token + connection string for a container. Use to replace an expired container SAS. |
| `util-get-content-type` | MIME type lookup by file name or extension. Returns `application/octet-stream` for unrecognised types. |
| `util-to-container-name` | Sanitise arbitrary text (email, URL, display name) into a valid Azure container name. Use BEFORE `blob-container-create`. |

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

### RooCode / Claude Desktop

Add to your VS Code MCP settings (`.vscode/mcp.json` or global settings):

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

---

## Deploy to Azure

### 1. Login

```bash
az login
azd auth login
```

### 2. Initialize (first time only)

```bash
azd init
```

This prompts you for an **environment name** (e.g. `mcp-azure-storage-dev`), **Azure subscription**, and **location**. It creates a `.azure/<env-name>/.env` file to store configuration for subsequent commands.

### 3. Set deployment variables

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

### 4. Deploy

#### Option A — Single command

```bash
azd up
```

#### Option B — Step-by-step (provision then deploy separately)

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

### 5. Test the deployed endpoint

```bash
curl -X POST https://<your-app>.azurecontainerapps.io/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-API-Key: <your-production-key>" \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'
```

### 6. Check deployment status

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

### 7. Redeploy after code changes

After modifying source code, rebuild and redeploy the container with:

```bash
azd deploy
```

This rebuilds the Docker image, pushes it to the Azure Container Registry, and updates the Container App — without re-provisioning infrastructure.

If you have also changed the Bicep infrastructure files (e.g. `infra/main.bicep`), run the full provision-and-deploy cycle instead:

```bash
azd up
```

### 8. Tear down the deployment

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
| `RATE_LIMIT_WINDOW_MINUTES` | No | `15` | Rate limit window (minutes) |
| `RATE_LIMIT_MAX_REQUESTS` | No | `300` | Max requests per window per IP |
| `MAX_SESSIONS` | No | `100` | Maximum concurrent stateful MCP sessions (returns 503 when full) |
| `SSE_KEEPALIVE_INTERVAL_MS` | No | `30000` | Interval (ms) between SSE keepalive heartbeats. Prevents Azure reverse proxy from killing idle SSE connections (~240s timeout). |

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
- **Helmet** — sets security headers (HSTS, X-Content-Type-Options, X-Frame-Options, etc.)
- **Rate limiting** — per-IP request throttling to prevent abuse
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

---

## Testing

### Unit Tests (86 tests, no Azure required)

Unit tests mock all Azure SDK modules and test through a stateless MCP HTTP endpoint using supertest. No Azure credentials or network access needed.

```bash
# Run all unit tests
npm test

# Watch mode
npm run test:watch

# With coverage report
npm run test:coverage
```

**Test coverage:** Config, API key middleware, all 35 tools across 5 modules, all 12 resources across 4 modules, format utility (JSON/HTML/MD).

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
│   └── utility-tools.test.ts
├── resources/                    # vi.hoisted + vi.mock for module-scope clients
│   ├── blob-resources.test.ts
│   ├── queue-resources.test.ts
│   ├── table-resources.test.ts
│   └── fileshare-resources.test.ts
└── integration/                  # Real CRUD against Azurite (gated by TEST_INTEGRATION)
    ├── blob-integration.test.ts
    ├── queue-integration.test.ts
    └── table-integration.test.ts
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
