# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-10-07

### Added

- **Item 1 — Structured error model** (`34e4072`)
  - All tools return machine-parseable JSON errors with `isError: true`, a fixed
    `code` set (`not_found`, `already_exists`, `lease_lost`, `immutable`,
    `archived`, `too_large`, `rate_limited`, `invalid`, `forbidden`, `backend`),
    HTTP status, Azure error code, retryable flag, and extra context fields.
  - Automatic sanitisation of SAS signatures and sensitive query parameters from
    error messages before they reach the client.

- **Item 2 — Rate limiting per endpoint** (`7dd5441`)
  - Separate rate-limit budgets for `/mcp` (JSON-RPC) and `/upload` (multipart):
    `RATE_LIMIT_MCP_MAX` (default 3000) and `RATE_LIMIT_UPLOAD_MAX` (default 600).
  - API-key-aware identity: requests with a valid `X-API-Key` are keyed by
    SHA-256(key) instead of IP, so authenticated clients get their own budget.
  - `TRUST_PROXY_HOPS` (default 1) for correct `X-Forwarded-For` resolution
    behind Azure Container Apps or CDN layers.
  - `RATE_LIMIT_WINDOW_SECONDS` replaces the legacy `RATE_LIMIT_WINDOW_MINUTES`;
    legacy vars still work as fallback.

- **Item 3 — Streaming uploads via busboy** (`e44c5cd`)
  - `POST /upload` streams multipart files directly to Azure Blob Storage
    through busboy + `BlockBlobClient.uploadStream` — no temp files, no
    full-file buffering.
  - `MAX_UPLOAD_BYTES` (default 5 GiB) hard byte limit; oversized files
    rejected with HTTP 413 and structured `code: "too_large"` body.
  - `MAX_JSON_BODY_BYTES` (default 50 MiB) for `/mcp` JSON payloads; oversized
    bodies rejected with HTTP 413 and a suggestion to use multipart upload.
  - Abort-safe: client disconnect or stream error destroys the PassThrough
    before `commitBlockList`, so no partial blobs are visible.

- **Item 4 — Queue work-queue lease renewal** (`55c8983`)
  - `queue-update-message` tool: update a JSON message body with additive
    fields (`state`, `progress`, `attempt`, `owner`, `details`) and optionally
    renew the visibility timeout (lease).
  - `queue-renew-lease` tool: renew a message's visibility timeout without
    changing the body. Requires `messageText` from the receive response.
  - `MAX_QUEUE_VISIBILITY_SECONDS` (default 3600) server-side cap on lease
    duration to prevent accidentally locking messages for days.

- **Item 5 — DISABLED_TOOLS gating**
  - `DISABLED_TOOLS` env var: comma-separated, case-insensitive list of tool
    names to disable at runtime.
  - Disabled tools are silently omitted from `tools/list` responses.
  - Invoking a disabled tool via `tools/call` returns a structured `"forbidden"`
    error with `data.reason: "disabled_tool"` and HTTP 403.
  - Unknown names in `DISABLED_TOOLS` log a startup warning but do not prevent
    the server from starting.

- **Item 6 — Lifecycle-supporting blob tools** (`7489ca4`)
  - `blob-head` tool: get blob properties (metadata, content type, size, tier,
    immutability, legal hold) without downloading content. Supports
    version-specific lookups via `versionId`.
  - `blob-set-tier` tool: change a blob's access tier (Hot, Cool, Archive) with
    optional `rehydratePriority` (High/Standard) and `versionId`.
  - `blob-list` enhancements: `prefix` filtering, `includeVersions` for version
    entries with `versionId`/`isCurrentVersion`, `pageSize` control.
  - `blob-read` enhancements: `versionId` for version-specific reads, `maxBytes`
    for partial reads with `truncated: true` indicator.
  - `blob-delete` enhancements: `versionId` for version-specific deletion;
    structured `immutable` error with `immutableUntil` for policy-protected blobs.

- **Item 7 — SAS improvements**
  - `expiryMinutes` parameter on SAS tools with `SAS_MAX_EXPIRY_MINUTES` ceiling
    (default 1440). Exceeding the ceiling returns a structured `"invalid"` error.
  - `SAS_PROTOCOL` env var: `"https"` (default) or `"https,http"` (required for
    Azurite). Controls the `spr` field in generated SAS tokens.
  - Permission validation via Azure SDK `BlobSASPermissions.parse()` /
    `ContainerSASPermissions.parse()` — invalid characters produce structured
    `"invalid"` errors with `field: "permissions"`.
  - `getBlobServiceBaseUrl()` helper: honours `AZURE_BLOB_SERVICE_URL` override
    for Azurite, otherwise constructs `https://<account>.blob.core.windows.net`.

- **Item 8 — `store-info` tool** (`7c5e7c9`)
  - Read-only snapshot of server runtime configuration: limits (`maxUploadBytes`,
    `maxJsonBodyBytes`, `sasMaxExpiryMinutes`), SAS protocol, disabled tools,
    auth mode, account name, blob service endpoint, and capabilities.
  - No secrets, keys, or connection strings are included in the output.
  - Accepts the standard `format` parameter (`json`, `html`, `md`).

### Breaking Changes

None — all changes are additive. Existing tool inputs and outputs are unchanged.

### Migration Notes

- **New environment variables** (all optional, with sensible defaults):

  | Variable | Default | Description |
  |----------|---------|-------------|
  | `MAX_UPLOAD_BYTES` | `5368709120` (5 GiB) | Hard byte limit for streaming multipart uploads |
  | `MAX_JSON_BODY_BYTES` | `52428800` (50 MiB) | Hard byte limit for JSON request bodies |
  | `MAX_QUEUE_VISIBILITY_SECONDS` | `3600` (1 hour) | Maximum visibility timeout for queue lease operations |
  | `DISABLED_TOOLS` | _(empty)_ | Comma-separated tool names to disable at runtime |
  | `SAS_MAX_EXPIRY_MINUTES` | `1440` (24 hours) | Ceiling for SAS token lifetime |
  | `SAS_PROTOCOL` | `https` | SAS protocol: `"https"` or `"https,http"` (for Azurite) |
  | `RATE_LIMIT_WINDOW_SECONDS` | `900` | Rate limit window in seconds |
  | `RATE_LIMIT_MCP_MAX` | `3000` | Max requests per window for `/mcp` |
  | `RATE_LIMIT_UPLOAD_MAX` | `600` | Max requests per window for `/upload` |
  | `TRUST_PROXY_HOPS` | `1` | Number of trusted reverse proxy hops |

- The total tool count increases from 39 to **42** (new: `blob-head`,
  `blob-set-tier`, `queue-update-message`, `queue-renew-lease`, `store-info`;
  existing utility tools now counted correctly at 8).
- No existing API calls need to change; new parameters are optional with
  backward-compatible defaults.

## [1.0.2] — 2026-06-01

- Dependency updates and container registry push scripts.

## [1.0.1] — 2026-05-15

- Bug fixes and stabilisation.

## [1.0.0] — 2026-04-01

- Initial release: 39 MCP tools, 12 resources, Blob/Queue/Table/File Share
  support, API key auth, Docker + Azure Container Apps deployment.
