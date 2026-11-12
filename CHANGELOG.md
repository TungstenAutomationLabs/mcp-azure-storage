# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Credential redaction in logs** (Veracode CWE-312, flaw 383) -- the structured logger (`src/utils/otel-logger.ts`) now passes every record through `src/utils/log-redaction.ts` before writing it to stdout or the OTel log exporter. Attributes named like credentials (password, secret, token, API key, authorization, cookie, SAS, account key, connection string, private key) are replaced with `[redacted]`, and `AccountKey=`, `SharedAccessSignature=`, `SharedAccessKey=`, SAS `sig=` values and bearer tokens are removed from messages and string attributes. Error messages from the Azure SDK, Node and busboy reach both sinks, and previously did so verbatim.
- **Startup banner reports state, not raw environment values** (Veracode CWE-312, flaws 377, 378, 379, 380) -- the banner no longer prints the TLS certificate and private key file locations, prints the trust-proxy value Express is using (or `invalid`) instead of the raw `TRUST_PROXY_HOPS` text, and lists disabled tools from the server's tool catalogue with a count of unknown entries instead of echoing `DISABLED_TOOLS`. The banner text is built by `src/utils/startup-banner.ts`.

- **Failed authentication is rate limited** (Veracode CWE-798 flaw 382 area) -- the `/mcp` and `/upload` limiters now run before API key authentication. Previously a request with a missing or wrong key was rejected before it was counted, so key guessing was never throttled, and with `MCP_API_KEY` unset every presented key opened its own budget. Requests with the configured key share the authenticated budget; all others are counted per client address (IPv6 grouped by /56). The limiter bucket no longer holds a digest of the API key (`src/utils/rate-limit-key.ts`).
- **API key comparison never throws** -- the key is compared as SHA-256 digests with `crypto.timingSafeEqual` (`src/utils/credentials.ts`), shared by authentication and rate limiting. A same-length key with multi-byte characters previously reached `timingSafeEqual` with unequal buffers and threw.
- **Startup banner contract** (Veracode CWE-312 flaw 384) -- the banner accepts only state words, allowlisted constants, safe integers and tool-catalogue names; `TLS_MIN_VERSION` is returned as the allowlisted constant; the unknown `DISABLED_TOOLS` warning reports a count instead of echoing the entries; an invalid `TLS_MIN_VERSION` error no longer echoes the value.
- **TLS logs without paths** (Veracode CWE-312 flaw 383) -- certificate reload and watcher records no longer include the certificate or key file locations.
- **Service URLs shown without secrets** -- the plain-HTTP warning for an `AZURE_*_SERVICE_URL` and the `store-info` tool's `endpoints.blobServiceUrl` show scheme, host, port and path only (`src/utils/safe-url.ts`), so a SAS token, credentials or fragment in a configured URL are not printed or returned to MCP clients. URLs without them are unchanged.
- **Recursive log redaction** -- the redaction boundary now handles nested objects, arrays, errors and stack traces, URL credentials and secret query parameters, cuts circular references, and withholds a record if redaction fails.

### Changed

- **Auth debug log attribute** -- the `/mcp` auth middleware's DEBUG record replaces the `xApiKey` and `authorization` attributes (`present`/`missing`) with one attribute, `authHeaders`, listing which credential headers were present (`x-api-key`, `authorization`, both, or `none`). The old names now fall under credential redaction.

## [1.4.1] -- 2026-11-09

### Fixed

- **Undici/fetch span scrubbing** -- `blob-upload-from-url` calls `fetch(sourceUrl)` which is traced by the undici instrumentation. Previously, source URLs (including SAS tokens, file names, and query strings) leaked into telemetry because only the HTTP instrumentation hook was scrubbing spans. The undici instrumentation now has a `responseHook` that applies the same scrubbing: storage URLs keep scheme + host + resource name only; non-storage URLs are stripped to scheme + host only; query strings are always removed.
- **Custom storage host detection** -- Azurite behind a Docker service name (e.g. `http://azurite:10000/...`) and custom domains from `AZURE_*_SERVICE_URL` env vars are now recognised as storage endpoints for PII scrubbing. Previously only standard Azure hostnames and `localhost`/`127.x`/`[::1]` were treated as storage.
- **`TRUST_PROXY_HOPS` default corrected in README** -- the Configuration Reference table previously showed `1` as the default; corrected to `0` (TLS) / `1` (no TLS), matching the actual server.ts behaviour since v1.4.0.

### Added

- **`scrubOutboundUrl()` function** -- new exported function in `src/utils/pii-scrubber.ts` for scrubbing any outbound URL. Storage endpoints delegate to `scrubUrl()`; non-storage endpoints are stripped to scheme + host only.
- **`isStorageHost()` function** -- new exported function in `src/utils/pii-scrubber.ts` that checks whether a hostname is any known storage endpoint (Azure, Azurite, or custom from `AZURE_*_SERVICE_URL`).
- **`scrubSpanUrlAttributes()` in instrumentation.cjs** -- shared function for both HTTP and undici span scrubbing, replacing the inline HTTP-only implementation.
- **Telemetry scrubbing integration test** -- `tests/integration/telemetry-scrub-integration.test.ts` wires real undici instrumentation to in-memory span exporters, performs fetch operations against Azurite, and asserts no blob paths, filenames, or query strings appear in exported spans.
- **17 new unit tests** in `tests/utils/telemetry-scrub.test.ts` covering `scrubOutboundUrl`, `isStorageHost`, and Docker/custom host scrubbing.
- **Stronger `blob-delete-batch` 257 assertion** -- the existing test now asserts the error message references "256".
- **5 improved `TRUST_PROXY_HOPS` tests** -- rewritten to mirror the exact server.ts expression including `TRUST_PROXY_HOPS=0` edge case.

### Changed

- **Documentation** -- `TLS_CERT_FILE`, `TLS_KEY_FILE`, `TLS_MIN_VERSION` added to README Configuration Reference and ENVIRONMENTS.md. `OTEL_SCRUB_PII` and `OTEL_SCRUB_HMAC_KEY` added to README Observability table. Health check under TLS guidance added to Quick Start section.

## [1.4.0] -- 2026-11-09

### Added

- **`blob-delete-batch` tool** -- delete up to 256 blobs in a single request using the Azure Blob Batch API. Each blob receives an individual status (`deleted`, `not_found`, or `failed`) so callers can handle partial failures. Blobs that do not exist are reported as `not_found` (safe for retries). Per-blob transient errors (e.g. 429, 503) are surfaced individually in the results array rather than thrown.
- **Unit tests** -- 5 new tests in `tests/tools/blob-tools.test.ts` covering result shape, per-blob failures, >256 rejection, empty list rejection, and KNOWN_TOOLS membership.
- **Integration tests** -- 3 new tests in `tests/integration/blob-integration.test.ts` covering batch delete of multiple blobs, missing-blob handling, and single-blob edge case.
- `blob-delete-batch` added to `KNOWN_TOOLS` set in `src/utils/metrics.ts` (43 total) and `KNOWN_TOOL_NAMES` in `src/server.ts`.

### Changed

- Total tool count increases from 42 to **43** (new: `blob-delete-batch`).
- Blob tool count increases from 13 to **14**.
- README, repo guide, architecture diagram, and test coverage descriptions updated to reflect new counts.

## [1.3.0] -- 2026-11-06

### Breaking

- **Stateless Streamable HTTP transport** -- sessions removed entirely. Every request creates a fresh `McpServer` + `StreamableHTTPServerTransport` with no session state surviving across requests or replicas. This eliminates "session not found" 404 errors when Azure Container Apps scales to multiple replicas. Clients that relied on `Mcp-Session-Id` for server-side state must switch to self-contained requests. Stale session headers are ignored gracefully (logged + counted, but no 404).
- **GET /mcp** now returns 405 (SSE streams are not supported in stateless mode).
- **DELETE /mcp** now returns 405 (no sessions to terminate).

### Changed

- **Auth middleware logging** -- replaced raw `console.log` in `src/middleware/api-key.ts` with OTel `debug()` / `warn()` / `error()` loggers. Request logs now emit structured attributes (`component: "auth"`, `xApiKey: "present"/"missing"`) via `src/utils/otel-logger.js`. No API key values or tokens appear in any log output.

### Added

- **OTel metrics** (`src/utils/metrics.ts`) -- four new counters:
  - `mcp.requests.total` -- request count by JSON-RPC method and tool name
  - `mcp.requests.errors` -- error count by method
  - `mcp.stale_sessions.received` -- requests carrying a stale `Mcp-Session-Id` header
  - `mcp.server.starts` -- server process start events
- **Tool-name sanitisation** -- `sanitiseToolName()` validates tool names against the `KNOWN_TOOLS` set before recording as metric labels; unknown values are replaced with `"unknown"` to prevent high-cardinality label explosions.
- **Replica name resource attribute** -- `CONTAINER_APP_REPLICA_NAME` (or `"local"`) is set as the `container_app.replica.name` OTel resource attribute in `src/instrumentation.cjs`, enabling per-replica dashboards.
- **Stale session logging** -- when a client sends an `Mcp-Session-Id` header in stateless mode, the first 8 characters of the session ID and the replica name are logged at `warn` level.
- **Tests** -- `tests/stateless-transport.test.ts` (12 tests), `tests/middleware/api-key.test.ts` (12 tests), `tests/utils/metrics.test.ts` (20 tests) covering stateless transport, auth logging, and metrics utilities.

## [1.2.4] -- 2026-10-27

### Security
- **npm audit** -- resolved all 5 vulnerabilities (body-parser high, fast-uri moderate x4, zod high, @azure/msal-node high x2) via `npm audit fix` and `overrides` in `package.json` forcing `@azure/msal-node>=7.1.1`
- **Encryption at rest** -- added explicit SSE (Storage Service Encryption) block to storage account in `infra/main.bicep` covering blob, file, queue, and table services with Microsoft-managed keys
- **BYOSA HTTPS validation** -- `src/config.ts` now logs a `[SECURITY WARNING]` when custom service URLs use plain HTTP (excludes localhost for Azurite compatibility)

### Changed
- **OTel Collector architecture** -- moved from sidecar container to a separate Container App with internal-only ingress and Container Apps-managed TLS (`allowInsecure: false`). The MCP server now sends telemetry to the collector's HTTPS FQDN instead of `http://localhost:4318`, achieving end-to-end encryption in transit as mandated by security policy.

### Added
- **PII scrubbing for OTel telemetry** -- new 3-layer defence-in-depth to prevent sensitive file names leaking into traces:
  1. **Application layer** (`src/utils/pii-scrubber.ts`) -- SHA-256 hashed segments for blob names, container names, and URLs; preserves directory structure and file extensions; controlled by `OTEL_SCRUB_PII` env var (default: `true`)
  2. **HTTP instrumentation hook** (`src/instrumentation.cjs`) -- `applyCustomAttributesOnSpan` scrubs `url.full`, `http.url`, and `http.target` span attributes on outbound HTTP spans
  3. **OTel Collector processor** (`otel/otel-collector-config.azure.yaml`) -- `transform/scrub_pii` processor with OTTL statements for defence-in-depth scrubbing of trace and log pipelines
- **`OTEL_SCRUB_PII` env var** -- configurable via `.env`, Bicep (`infra/main.bicep`), parameters (`infra/main.parameters.json`), and deploy script (`deploy_to_azure.ps1`); defaults to `true`
- **Unit tests** (`tests/utils/pii-scrubber.test.ts`) -- 30 tests covering `hashSegment`, `scrubBlobName`, `scrubContainerName`, `scrubUrl`, `isPiiScrubEnabled`, and conditional scrubbing functions

### Changed
- `src/utils/errors.ts` -- span attribute enrichment now uses `maybeScrubBlobName()` and `maybeScrubContainerName()` for `blob.name` and `blob.container_name` attributes

## [1.2.3] -- 2026-10-22

### Changed
- **Node.js runtime** -- migrated from Node.js 20 to Node.js 26.12.1
  - `engines` field in `package.json` updated to `>=26.0.0`
  - Dockerfile base images updated from `node:20-alpine` to `node:26-alpine`
  - CI matrix updated from `[20, 22]` to `[26]`
  - README prerequisites updated to require Node.js 26+
- **Vitest** upgraded from 4.1.11 to 5.0.5 (resolves 3 moderate security advisories: GHSA-qxg6-89mg-rqv8, GHSA-xp26-3454-mjgp)
- **ip-address** transitive dependency updated to resolve ReDoS advisory (GHSA-rxp7-6hxx-x8q5)
- Zero npm audit vulnerabilities

### Breaking Changes

- **Node.js 20/22 no longer supported** -- the minimum required version is now Node.js 26.0.0.
  Update your local development environment and CI/CD runners before upgrading.

## [1.2.2] -- 2026-10-15

### Fixed
- Hardcoded version string (1.2.0) in MCP server constructor and startup banner now reads dynamically from package.json
- Console log output now respects `OTEL_LOG_MIN_SEVERITY` threshold -- debug lines no longer emitted in production
- Default telemetry level changed from `detailed` to `basic` to match documented behaviour (10% trace sampling, WARN+ logs, 60s metrics interval)

## [1.2.1] -- 2026-10-11

### Fixed

- **Deploy script** (`deploy_to_azure.ps1`)
  - PowerShell 5.1 `ConvertFrom-Json` array enumeration bug -- wrap pipeline output
    with `@()` to guarantee array semantics regardless of PS version
  - ACR login-server detection false-positive -- use exact-match parsing instead of
    substring match that could collide with similarly-named registries
  - ACR build ordering -- defer OTel Collector image build until after the main
    application image, preventing race conditions during first-time deployments

- **Bicep template** (`infra/main.bicep`)
  - Chicken-and-egg OTel sidecar -- make the OTel Collector sidecar container
    conditional so the Container App can deploy successfully before the collector
    image exists in ACR

- **Streaming upload false abort** (`src/server.ts`)
  - Streaming uploads falsely aborted when the request body completes before the
    Azure upload finishes. Changed guard from `req.close` to `req.complete` so
    the PassThrough stream stays open until Azure confirms the upload.

- **Server crash on client disconnect** (`src/server.ts`)
  - Client disconnect during upload crashes the server process. Added missing
    `error` listener on the PassThrough stream to catch and handle pipe errors
    gracefully instead of propagating an uncaught exception.
  - Deep fix: added `.catch()` on the `uploadPromise` so rejected Azure SDK
    promises cannot surface as unhandled rejections. Added process-level
    `uncaughtException` and `unhandledRejection` safety nets that log and
    exit cleanly instead of crashing silently.

- **File-before-fields hang** (`src/server.ts`)
  - File part sent before form fields (container, blobName) hangs the request
    indefinitely because the upload starts without a valid blob client. Now
    returns HTTP 400 with `code: "invalid_field_order"` immediately.

- **DISABLED_TOOLS false warnings** (`src/utils/disabled-tools.ts`, `src/tools/utility-tools.ts`)
  - `DISABLED_TOOLS` validation warns on every valid tool name because SDK
    introspection returned an empty tool set at startup. Replaced SDK
    introspection with a static tool name registry for reliable validation.

- **DISABLED_TOOLS pipeline fix** (`deploy_to_azure.ps1`)
  - `DISABLED_TOOLS` env var was not included in the `$syncKeys` array, so
    changes to the disabled-tools list were silently dropped during
    re-deployment. Added `DISABLED_TOOLS` to `$syncKeys` to ensure it is
    synced to the Container App environment.

- **Monitoring connection string leak** (`scripts/setup-monitoring.ps1`, `infra/main.bicep`)
  - `setup-monitoring.ps1` printed the full Application Insights connection
    string (which contains an ingestion key) to the console. Now redacted
    with a message directing users to the Azure Portal or Key Vault.
  - Removed the `appInsightsConnectionString` Bicep deployment output from
    `infra/main.bicep`. The connection string is passed to the Container App
    as a secret env var only.

- **Workbook name and GUID alignment** (`otel/workbook.bicep`, `infra/main.bicep`)
  - The workbook display name and deterministic GUID seed differed between
    `otel/workbook.bicep` (script path) and `infra/main.bicep` (azd path),
    causing duplicate workbook resources on re-deployment. Both now use the
    same display name (`MCP Azure Storage Monitoring`) and GUID seed
    (`resourceGroup().id, 'mcp-storage-monitoring'`).

- **OTel requirement warning** (`scripts/setup-monitoring.ps1`)
  - Added a post-deploy warning that the workbook requires OTel to be enabled
    (`-EnableOTel` flag on `deploy_to_azure.ps1`) for telemetry data to appear.

### Changed

- **Upload field ordering documentation** (`src/tools/utility-tools.ts`)
  - `util-get-upload-url` tool response now documents the required field
    ordering: `containerName` and `blobName` must appear before the `file`
    part in the multipart form. Includes `fieldOrder` warning and updated
    field descriptions.

- **Monitoring documentation** (`ENVIRONMENTS.md`)
  - Added "Monitoring and Telemetry" section covering OTel enablement,
    connection string security, and the requirement for the OTel Collector
    sidecar to populate workbook dashboards.

## [1.2.0] -- 2026-10-09

### Added

- **OpenTelemetry monitoring** -- Opt-in observability via OTel Collector sidecar
  - Traces, metrics, and logs exported to Azure Monitor / Application Insights
  - Activation guard: zero overhead when `OTEL_EXPORTER_OTLP_ENDPOINT` is not set
  - Telemetry level control (`OTEL_TELEMETRY_LEVEL`): `off`, `basic` (default), `detailed`, `full`
  - Fine-grained cost controls: trace sampling ratio, metrics interval, log severity threshold
  - Session ID (`mcp-session-id` header) propagated to server spans for dashboard slicing
  - Tool span enrichment: `mcp.tool.name`, `peer.service`, blob operation attributes
  - Structured OTel logger with trace-to-log correlation

- **OTel Collector configuration** (`otel/`)
  - Azure Monitor-only config (`otel-collector-config.azure.yaml`)
  - Custom collector Dockerfile for ACA sidecar deployment
  - Addresses 20 traps from the observability-test spike project

- **Azure infrastructure** (`infra/main.bicep`)
  - Application Insights resource (conditional on `enableOtel`)
  - OTel Collector sidecar container in Container App
  - Configurable log retention (`logRetentionDays`, 30-730 days)
  - Azure Workbook with 4 tabs: Overview, Tools, Data Volume, Logs
  - Alert rules: high error rate and latency degradation (warning-only)

- **Deploy script** (`deploy_to_azure.ps1`)
  - `-EnableOTel` switch: provisions App Insights + builds/pushes collector image
  - `-LogRetentionDays` parameter (default 30)

- **Monitoring setup script** (`scripts/setup-monitoring.ps1`)
  - Standalone provisioning of App Insights and Log Analytics workspace
  - KQL verification queries for all five App Insights tables
  - `-VerifyOnly` mode for post-deployment validation

### Breaking Changes

None -- all changes are additive. OTel is disabled by default.

### Migration Notes

- **New environment variables** (all optional):

  | Variable | Default | Description |
  |----------|---------|-------------|
  | `OTEL_EXPORTER_OTLP_ENDPOINT` | _(unset)_ | Activates OTel when set |
  | `OTEL_TELEMETRY_LEVEL` | `basic` | Controls data volume: off/basic/detailed/full |
  | `OTEL_SERVICE_NAME` | `mcp-azure-storage` | Service name in traces |
  | `OTEL_TRACES_SAMPLER_ARG` | `0.1` | Trace sampling ratio (0.0-1.0) |
  | `OTEL_METRICS_EXPORT_INTERVAL_MS` | `60000` | Metric export interval |
  | `OTEL_LOG_MIN_SEVERITY` | `WARN` | Minimum log severity for export |

- **New deploy script parameters**:
  - `-EnableOTel` -- Provisions OTel infrastructure
  - `-LogRetentionDays` -- Data retention period (30-730 days)

- Test count increases from 285 to **312** (27 new OTel-related tests).

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
