# MCP Azure Storage Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes **41 tools** for managing Azure Storage — Blob, Queue, Table, and File Share — over a single HTTP endpoint. Designed for use with TotalAgility, AI assistants (Claude, RooCode, Copilot), Postman, MCP Inspector, and any MCP-compatible client.

Deploys to **Azure Container Apps** with automatic HTTPS, managed identity, and Bicep infrastructure-as-code.

---

## Features

- **41 MCP tools** across 5 categories (Blob, Queue, Table, File Share, Utilities)
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
                            ┌─────────┬───────────┼───────────┬─────────┐
                            ▼         ▼           ▼           ▼         ▼
                        ┌───────┐ ┌───────┐ ┌─────────┐ ┌─────────┐ ┌───────┐
                        │ Blob  │ │ Queue │ │  Table  │ │  File   │ │ Util  │
                        │ Tools │ │ Tools │ │  Tools  │ │  Share  │ │ Tools │
                        │ (11)  │ │  (8)  │ │   (7)   │ │   (9)   │ │  (6)  │
                        └───┬───┘ └───┬───┘ └────┬────┘ └────┬────┘ └───┬───┘
                            │         │          │           │         │
                            └─────────┴──────────┴───────────┴─────────┘
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
│   └── tools/
│       ├── blob-tools.ts      # 11 tools — container + blob CRUD, SAS, metadata
│       ├── queue-tools.ts     #  8 tools — queue CRUD + message operations
│       ├── table-tools.ts     #  7 tools — table CRUD + entity operations
│       ├── fileshare-tools.ts #  9 tools — share/directory/file operations
│       └── utility-tools.ts   #  5 tools — base64, SAS refresh, MIME lookup
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
| `blob-container-list` | List all blob containers |
| `blob-container-create` | Create a container if it doesn't exist |
| `blob-container-delete` | Delete a container |
| `blob-container-exists` | Check if a container exists |
| `blob-list` | List blobs with optional prefix filter & metadata |
| `blob-create` | Upload a blob (base64 content + optional metadata) |
| `blob-read` | Download blob content as base64 |
| `blob-delete` | Delete a blob |
| `blob-set-metadata` | Set custom metadata on a blob |
| `blob-get-sas-url` | Generate a SAS URL for a specific blob |
| `blob-get-container-sas` | Generate a SAS token for an entire container |

### Queue Storage (8 tools)

| Tool | Description |
|------|-------------|
| `queue-list` | List all queues |
| `queue-create` | Create a queue if it doesn't exist |
| `queue-delete` | Delete a queue |
| `queue-send-message` | Send a message with optional TTL |
| `queue-peek-messages` | Peek at messages without removing them |
| `queue-receive-messages` | Receive and dequeue messages |
| `queue-delete-message` | Delete a specific message by ID + pop receipt |
| `queue-get-properties` | Get queue properties (approx. message count) |

### Table Storage (7 tools)

| Tool | Description |
|------|-------------|
| `table-list` | List all tables |
| `table-create` | Create a table if it doesn't exist |
| `table-delete` | Delete a table |
| `table-entity-upsert` | Insert or merge an entity — pass `partitionKey`, `rowKey`, and a flat `entity` JSON object (`{"name": "Alice", "score": 95}`) |
| `table-entity-get` | Get entity by partition key + row key |
| `table-entity-query` | Query entities with OData filter |
| `table-entity-delete` | Delete an entity |

### File Share (9 tools)

| Tool | Description |
|------|-------------|
| `fileshare-list-shares` | List all file shares |
| `fileshare-create-share` | Create a file share |
| `fileshare-delete-share` | Delete a file share |
| `fileshare-create-directory` | Create nested directories |
| `fileshare-delete-directory` | Delete a directory (must be empty) |
| `fileshare-list` | List files and subdirectories |
| `fileshare-upload-file` | Upload a file (base64 content) |
| `fileshare-read-file` | Download file content as base64 |
| `fileshare-delete-file` | Delete a file |

### Utilities (6 tools)

| Tool | Description |
|------|-------------|
| `util-to-base64` | Encode text to base64 |
| `util-from-base64` | Decode base64 to text |
| `util-refresh-blob-sas` | Generate a fresh SAS token for a blob |
| `util-refresh-container-sas` | Generate a fresh SAS token for a container |
| `util-get-content-type` | MIME type lookup by file name/extension |
| `util-to-container-name` | Convert arbitrary text (email, URL, etc.) to a valid container name |

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
