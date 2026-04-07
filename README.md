# MCP Azure Storage Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes **42 tools** and **12 resources** for managing Azure Storage — Blob, Queue, Table, and File Share — over a single HTTP endpoint. Designed for use with TotalAgility, AI assistants (Claude, RooCode, Copilot), Postman, MCP Inspector, and any MCP-compatible client.

Deploys to **Azure Container Apps** with automatic HTTPS, managed identity, and Bicep infrastructure-as-code.

---

## Features

- **42 MCP tools** across 5 categories (Blob, Queue, Table, File Share, Utilities)
- **12 MCP resources** — read-only, URI-addressable data for LLM context (listings, content reads, properties)
- **Dual-mode transport** — stateful sessions for MCP clients + stateless one-shot for HTTP testing
- **API key authentication** with constant-time comparison (X-API-Key header or Bearer token)
- **Rate limiting** — configurable per-IP request limits
- **Security headers** via Helmet
- **Session TTL** — automatic cleanup of idle sessions (30 min)
- **SAS token generation** — blob and container-level shared access signatures
- **Base64 content encoding** — upload/download binary files through JSON
- **Docker** — multi-stage build, non-root container user
- **Azure Container Apps** — Bicep IaC, auto-HTTPS, scale-to-zero

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
                      │ Blob (11) │ Queue (8)     │ Blob (4)  │ Queue (2)    │
                      │ Table (7) │ FileShare (10)│ Table (2) │ FileShare (4)│
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
│   │   ├── blob-tools.ts      # 11 tools — container + blob CRUD, SAS, metadata
│   │   ├── queue-tools.ts     #  8 tools — queue CRUD + message operations
│   │   ├── table-tools.ts     #  7 tools — table CRUD + entity operations
│   │   ├── fileshare-tools.ts # 10 tools — share/directory/file operations
│   │   └── utility-tools.ts   #  6 tools — base64, SAS refresh, MIME lookup
│   └── resources/
│       ├── blob-resources.ts      #  4 resources — containers, blobs, properties
│       ├── fileshare-resources.ts #  4 resources — shares, files, properties
│       ├── queue-resources.ts     #  2 resources — queues, queue properties
│       └── table-resources.ts     #  2 resources — tables, entity lookup
├── infra/
│   ├── main.bicep             # Azure Container Apps + Storage + RBAC
│   └── main.parameters.json   # azd-templated deployment parameters
├── docs/                      # Internal design documents (gitignored)
├── Dockerfile                 # Multi-stage build, non-root user
├── .dockerignore              # Excludes .env, docs, infra from image
├── azure.yaml                 # Azure Developer CLI project definition
├── .env.example               # Template for local environment variables
├── .gitignore                 # Ignores .env, dist, node_modules, docs
├── tsconfig.json              # TypeScript configuration
├── package.json               # Dependencies and scripts
└── LICENSE                    # Project license
```

---

## Available Tools

### Blob Storage (11 tools)

| Tool | Description |
|------|-------------|
| `blob-container-list` | List all blob containers with names and last-modified dates. Use to discover available containers. |
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

### Queue Storage (8 tools)

| Tool | Description |
|------|-------------|
| `queue-list` | List all queue names in the storage account. |
| `queue-create` | Create a queue (idempotent). Use before sending messages to a new queue. |
| `queue-delete` | **Destructive** — permanently delete a queue and ALL pending messages. Check `queue-get-properties` first. |
| `queue-send-message` | Send a text message to a queue with optional TTL. For structured data, serialise as JSON string. |
| `queue-peek-messages` | Preview messages at the front of a queue WITHOUT removing them. Messages stay visible to other receivers. |
| `queue-receive-messages` | Receive and hide messages for processing. Call `queue-delete-message` after processing to permanently remove each message. |
| `queue-delete-message` | Permanently remove a processed message. Requires `messageId` + `popReceipt` from `queue-receive-messages`. |
| `queue-get-properties` | Get queue properties including approximate pending message count. |

### Table Storage (7 tools)

| Tool | Description |
|------|-------------|
| `table-list` | List all table names in the storage account. |
| `table-create` | Create a table (idempotent). Use before upserting entities to a new table. |
| `table-delete` | **Destructive** — permanently delete a table and ALL entities. |
| `table-entity-upsert` | Insert or merge-update an entity. Pass `partitionKey`, `rowKey`, and a flat `entity` JSON object (`{"name": "Alice", "score": 95}`). Merge preserves existing properties not in the request. |
| `table-entity-get` | Get a single entity by exact partition key + row key (fastest lookup). |
| `table-entity-query` | Query entities with an OData filter (e.g. `PartitionKey eq 'sales'`). Omit the filter to return all rows up to the limit. |
| `table-entity-delete` | **Destructive** — permanently delete a single entity by partition key + row key. |

### File Share (10 tools)

| Tool | Description |
|------|-------------|
| `fileshare-list-shares` | List all file shares with names and properties (quota, last modified). |
| `fileshare-create-share` | Create a file share (idempotent). Use before uploading files to a new share. |
| `fileshare-delete-share` | **Destructive** — permanently delete a share and ALL files/directories inside it. |
| `fileshare-create-directory` | Create a directory and any missing parents (idempotent). Or let `fileshare-upload-file` auto-create directories. |
| `fileshare-delete-directory` | Delete a directory (must be empty — remove all contents first). Use `fileshare-list` to check. |
| `fileshare-list` | List files and subdirectories in a directory. Returns name, kind (`file`/`directory`), size, and last-modified. |
| `fileshare-upload-file` | Upload a file (base64 content). Auto-creates parent directories. Use `util-to-base64` to encode text first. |
| `fileshare-read-file` | Download file content as base64. Use `util-from-base64` to decode text. |
| `fileshare-delete-file` | **Destructive** — permanently delete a file from a share. |
| `fileshare-get-file-properties` | Get file properties (size, content type, timestamps, metadata) without downloading the content. |

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
   Rate limit   : 300 req / 15 min per IP
   Session TTL  : 30 minutes
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
    "name": "blob-container-list",
    "arguments": {}
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

### 3. Set secrets

```bash
azd env set MCP_API_KEY "$(openssl rand -base64 24)"
```

### 4. Deploy

```bash
azd up
```

This provisions via Bicep:
- **Resource Group** with Container Apps Environment
- **Azure Storage Account** (Standard_LRS, TLS 1.2)
- **Azure Container App** with auto-HTTPS on `*.azurecontainerapps.io`
- **RBAC** — Blob, Queue, and Table Data Contributor roles
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
| `SAS_EXPIRY_HOURS` | No | `24` | Default SAS token expiry (hours) |
| `SAS_DEFAULT_PERMISSIONS` | No | `rl` | Default SAS permissions |
| `RATE_LIMIT_WINDOW_MINUTES` | No | `15` | Rate limit window (minutes) |
| `RATE_LIMIT_MAX_REQUESTS` | No | `300` | Max requests per window per IP |

---

## Security

- **Fail-closed authentication** — all requests are rejected if `MCP_API_KEY` is not set
- **Constant-time comparison** — API key validation uses `crypto.timingSafeEqual` to prevent timing attacks
- **No query-param auth** — API keys are only accepted via headers (not URLs that leak to logs)
- **Helmet** — sets security headers (HSTS, X-Content-Type-Options, X-Frame-Options, etc.)
- **Rate limiting** — per-IP request throttling to prevent abuse
- **Session TTL** — idle sessions are automatically evicted after 30 minutes
- **Non-root Docker** — container runs as unprivileged `appuser`
- **Secrets in Bicep** — storage keys and API keys are injected as Container App secrets via `@secure()` parameters
- **`.env` gitignored** — credentials never enter version control

---

## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `npm run dev` | Start dev server with hot reload (`tsx watch`) |
| `build` | `npm run build` | Compile TypeScript to `dist/` |
| `start` | `npm run start` | Run compiled production build |

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
