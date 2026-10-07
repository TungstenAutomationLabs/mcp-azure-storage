/**
 * Azure Storage configuration singleton with dual-mode authentication.
 *
 * Supports two credential modes:
 *
 *  1. **Shared Key** (default) — uses `AZURE_STORAGE_ACCOUNT_KEY` to create a
 *     `StorageSharedKeyCredential`. Required for local dev, Azurite, and SAS
 *     token generation.
 *
 *  2. **Managed Identity** — uses `DefaultAzureCredential` from `@azure/identity`
 *     for keyless authentication. Enabled by setting `AZURE_USE_MANAGED_IDENTITY=true`.
 *     Requires RBAC role assignments (Blob/Queue/Table Data Contributor) on the
 *     storage account for the managed identity. The infrastructure in
 *     `infra/main.bicep` already provisions these roles.
 *
 * When managed identity is enabled:
 *  - Data operations (read, write, list, delete) use `DefaultAzureCredential`.
 *  - SAS token generation requires a shared key OR uses User Delegation SAS.
 *    If `AZURE_STORAGE_ACCOUNT_KEY` is also set, it is used exclusively for
 *    SAS generation. If not, SAS tools will attempt User Delegation SAS
 *    (requires the identity to have `Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey` permission).
 *
 * Required environment variables:
 *  - `AZURE_STORAGE_ACCOUNT_NAME` — the storage account name (e.g. "mystorageaccount")
 *  - `AZURE_STORAGE_ACCOUNT_KEY`  — required unless `AZURE_USE_MANAGED_IDENTITY=true`
 *
 * Optional environment variables:
 *  - `AZURE_USE_MANAGED_IDENTITY` — set to "true" to use DefaultAzureCredential
 *  - `SAS_EXPIRY_HOURS`           — default SAS token lifetime in hours (default: 24)
 *  - `SAS_DEFAULT_PERMISSIONS`    — default SAS permission string (default: "rl")
 *  - `SAS_MAX_EXPIRY_MINUTES`     — ceiling for SAS token lifetime in minutes (default: 1440 = 24h)
 *  - `SAS_PROTOCOL`               — SAS protocol: "https" (default) or "https,http" (for Azurite)
 *  - `AZURE_BLOB_SERVICE_URL`     — override Blob service URL (for Azurite or emulator)
 *  - `AZURE_QUEUE_SERVICE_URL`    — override Queue service URL (for Azurite or emulator)
 *  - `AZURE_TABLE_SERVICE_URL`    — override Table service URL (for Azurite or emulator)
 *  - `AZURE_FILE_SERVICE_URL`     — override File Share service URL (for Azurite or emulator)
 *
 * @module config
 */

import {
  StorageSharedKeyCredential,
  BlobSASPermissions,
  ContainerSASPermissions,
  SASProtocol,
} from "@azure/storage-blob";
import type { TokenCredential } from "@azure/identity";

/** Allowed SAS protocol values (normalised to lowercase). */
export type SasProtocolValue = "https" | "https,http";

/** Shape of the cached storage configuration. */
export interface StorageConfig {
  /** Azure Storage account name (e.g. "mystorageaccount"). */
  accountName: string;
  /**
   * Base64-encoded shared key for the storage account.
   * May be empty string when using managed identity without a fallback key.
   */
  accountKey: string;
  /** Whether managed identity authentication is enabled. */
  useManagedIdentity: boolean;
  /** Default SAS token expiry in hours (from env or 24). */
  sasExpiryHours: number;
  /** Default SAS permission string (from env or "rl"). */
  sasDefaultPermissions: string;
  /** Maximum allowed SAS token lifetime in minutes (from env or 1440). */
  sasMaxExpiryMinutes: number;
  /** SAS protocol selection: "https" or "https,http" (from env or "https"). */
  sasProtocol: SasProtocolValue;
  /**
   * Optional endpoint URL overrides for local emulators (Azurite).
   * When set, SDK clients use these URLs instead of constructing from accountName.
   */
  blobServiceUrl?: string;
  queueServiceUrl?: string;
  tableServiceUrl?: string;
  fileServiceUrl?: string;
}

/** Cached singleton — populated on first call to getStorageConfig(). */
let _config: StorageConfig | null = null;

/**
 * Return the storage configuration, reading from environment variables on
 * first call. Throws immediately if required variables are missing (fail-fast).
 *
 * In managed identity mode, `AZURE_STORAGE_ACCOUNT_KEY` is optional — data
 * operations use `DefaultAzureCredential` instead. The key is still accepted
 * as a fallback for SAS token generation.
 *
 * @returns The cached StorageConfig singleton.
 * @throws {Error} If AZURE_STORAGE_ACCOUNT_NAME is not set, or if neither
 *   AZURE_STORAGE_ACCOUNT_KEY nor AZURE_USE_MANAGED_IDENTITY is configured.
 */
export function getStorageConfig(): StorageConfig {
  if (_config) return _config;

  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY || "";
  const useManagedIdentity =
    (process.env.AZURE_USE_MANAGED_IDENTITY ?? "").toLowerCase() === "true";

  if (!accountName) {
    throw new Error(
      "Missing required environment variable: AZURE_STORAGE_ACCOUNT_NAME"
    );
  }

  // At least one authentication method must be configured
  if (!accountKey && !useManagedIdentity) {
    throw new Error(
      "No credentials configured. Set AZURE_STORAGE_ACCOUNT_KEY for shared key auth, " +
      "or set AZURE_USE_MANAGED_IDENTITY=true for managed identity auth."
    );
  }

  // Parse SAS_MAX_EXPIRY_MINUTES (default 1440 = 24h, minimum 1)
  const rawMaxExpiry = parseInt(process.env.SAS_MAX_EXPIRY_MINUTES || "1440", 10);
  const sasMaxExpiryMinutes = isNaN(rawMaxExpiry) || rawMaxExpiry < 1 ? 1440 : rawMaxExpiry;

  // Parse SAS_PROTOCOL (default "https"; allow "https,http" for Azurite)
  const rawProtocol = (process.env.SAS_PROTOCOL || "https").toLowerCase().trim();
  const sasProtocol: SasProtocolValue =
    rawProtocol === "https,http" || rawProtocol === "http,https"
      ? "https,http"
      : "https";

  _config = {
    accountName,
    accountKey,
    useManagedIdentity,
    sasExpiryHours: parseInt(process.env.SAS_EXPIRY_HOURS || "24", 10),
    sasDefaultPermissions: process.env.SAS_DEFAULT_PERMISSIONS || "rl",
    sasMaxExpiryMinutes,
    sasProtocol,
    blobServiceUrl: process.env.AZURE_BLOB_SERVICE_URL || undefined,
    queueServiceUrl: process.env.AZURE_QUEUE_SERVICE_URL || undefined,
    tableServiceUrl: process.env.AZURE_TABLE_SERVICE_URL || undefined,
    fileServiceUrl: process.env.AZURE_FILE_SERVICE_URL || undefined,
  };

  return _config;
}

/**
 * Check whether a shared key is available for SAS token generation.
 *
 * SAS tokens require a `StorageSharedKeyCredential`. When running in
 * managed-identity-only mode (no key), SAS tools must use User Delegation
 * SAS or return a clear error.
 *
 * @returns `true` if `AZURE_STORAGE_ACCOUNT_KEY` is set and non-empty.
 */
export function hasSharedKey(): boolean {
  const config = getStorageConfig();
  return config.accountKey.length > 0;
}

/**
 * Return a `StorageSharedKeyCredential` for operations that require it
 * (SAS token generation, Azurite connections, etc.).
 *
 * @throws {Error} If no shared key is available (managed-identity-only mode).
 */
export function getSharedKeyCredential(): StorageSharedKeyCredential {
  const config = getStorageConfig();
  if (!config.accountKey) {
    throw new Error(
      "Shared key not available. SAS token generation requires AZURE_STORAGE_ACCOUNT_KEY. " +
      "Set the key alongside managed identity, or use User Delegation SAS."
    );
  }
  return new StorageSharedKeyCredential(config.accountName, config.accountKey);
}

/**
 * Return the appropriate credential for data operations (read, write, list, delete).
 *
 * - In **shared key mode** (default): returns a `StorageSharedKeyCredential`.
 * - In **managed identity mode**: returns a `DefaultAzureCredential` from
 *   `@azure/identity`, which automatically discovers the best available
 *   credential (managed identity in Azure, Azure CLI locally, etc.).
 *
 * The returned credential is suitable for constructing any Azure Storage
 * SDK client (BlobServiceClient, QueueServiceClient, etc.).
 *
 * @returns A credential object accepted by Azure Storage SDK clients.
 */
export async function getCredential(): Promise<StorageSharedKeyCredential | TokenCredential> {
  const config = getStorageConfig();

  if (config.useManagedIdentity) {
    // Dynamic import to avoid pulling in @azure/identity when not needed.
    // This package is already a dependency in package.json.
    const { DefaultAzureCredential } = await import("@azure/identity");
    return new DefaultAzureCredential();
  }

  return new StorageSharedKeyCredential(config.accountName, config.accountKey);
}

// ══════════════════════════════════════════════════════════════════════════════
// SAS HELPERS — shared logic for expiry, protocol, permissions, and URL building
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Result of resolving SAS expiry from expiryMinutes / expiryHours inputs.
 */
export interface ResolvedSasExpiry {
  /** Resolved expiry duration in minutes. */
  minutes: number;
  /** Absolute Date when the SAS token expires. */
  expiresOn: Date;
}

/**
 * Resolve the effective SAS expiry in minutes from optional expiryMinutes
 * and expiryHours inputs, enforcing the configured ceiling.
 *
 * Priority: expiryMinutes > expiryHours > config.sasExpiryHours (as minutes).
 *
 * Throws an InvalidArgumentError if the resolved value exceeds
 * `SAS_MAX_EXPIRY_MINUTES` or is less than 1.
 *
 * @param expiryMinutes - Optional expiry in minutes (takes precedence).
 * @param expiryHours   - Optional expiry in hours (fallback).
 * @returns Resolved minutes and absolute expiry Date.
 * @throws {Error} (name: InvalidArgumentError) if out of bounds.
 */
export function resolveSasExpiry(
  expiryMinutes?: number,
  expiryHours?: number,
): ResolvedSasExpiry {
  const config = getStorageConfig();
  const ceiling = config.sasMaxExpiryMinutes;

  let minutes: number;
  let source: string;
  if (expiryMinutes != null) {
    minutes = expiryMinutes;
    source = "expiryMinutes";
  } else if (expiryHours != null) {
    minutes = expiryHours * 60;
    source = "expiryHours";
  } else {
    minutes = config.sasExpiryHours * 60;
    source = "SAS_EXPIRY_HOURS default";
  }

  if (minutes < 1) {
    const err = new Error(
      `${source} must be at least 1 minute (got ${minutes}).`
    ) as Error & { name: string; code: string; field: string };
    err.name = "InvalidArgumentError";
    err.code = "ERR_INVALID_ARG";
    err.field = expiryMinutes != null ? "expiryMinutes" : "expiryHours";
    throw err;
  }

  if (minutes > ceiling) {
    const err = new Error(
      `${source} exceeds maximum allowed SAS expiry of ${ceiling} minutes (got ${minutes}).`
    ) as Error & { name: string; code: string; field: string };
    err.name = "InvalidArgumentError";
    err.code = "ERR_INVALID_ARG";
    err.field = expiryMinutes != null ? "expiryMinutes" : "expiryHours";
    throw err;
  }

  const expiresOn = new Date();
  expiresOn.setMinutes(expiresOn.getMinutes() + minutes);
  return { minutes, expiresOn };
}

/**
 * Map the configured SAS protocol to the Azure SDK `SASProtocol` enum.
 *
 * @returns `SASProtocol.Https` or `SASProtocol.HttpsAndHttp`.
 */
export function getSasProtocol(): SASProtocol {
  const config = getStorageConfig();
  return config.sasProtocol === "https,http"
    ? SASProtocol.HttpsAndHttp
    : SASProtocol.Https;
}

/**
 * Validate a SAS permissions string for blob-level operations using the
 * Azure SDK `BlobSASPermissions.parse()`. Throws a structured invalid error
 * if the string is malformed or contains unsupported characters.
 *
 * @param permissions - The raw permissions string (e.g. "r", "rwd").
 * @returns The parsed `BlobSASPermissions` object.
 * @throws {Error} (name: InvalidArgumentError) if parsing fails.
 */
export function validateBlobPermissions(permissions: string): BlobSASPermissions {
  try {
    return BlobSASPermissions.parse(permissions);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const err = new Error(
      `Invalid blob SAS permissions "${permissions}": ${msg}`
    ) as Error & { name: string; code: string; field: string };
    err.name = "InvalidArgumentError";
    err.code = "ERR_INVALID_ARG";
    err.field = "permissions";
    throw err;
  }
}

/**
 * Validate a SAS permissions string for container-level operations using the
 * Azure SDK `ContainerSASPermissions.parse()`. Throws a structured invalid error
 * if the string is malformed or contains unsupported characters.
 *
 * @param permissions - The raw permissions string (e.g. "rl", "rwdl").
 * @returns The parsed `ContainerSASPermissions` object.
 * @throws {Error} (name: InvalidArgumentError) if parsing fails.
 */
export function validateContainerPermissions(permissions: string): ContainerSASPermissions {
  try {
    return ContainerSASPermissions.parse(permissions);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const err = new Error(
      `Invalid container SAS permissions "${permissions}": ${msg}`
    ) as Error & { name: string; code: string; field: string };
    err.name = "InvalidArgumentError";
    err.code = "ERR_INVALID_ARG";
    err.field = "permissions";
    throw err;
  }
}

/**
 * Build the base blob service URL, honouring configured endpoint overrides.
 *
 * When `AZURE_BLOB_SERVICE_URL` is set (e.g. for Azurite), returns that URL.
 * Otherwise constructs the standard `https://<accountName>.blob.core.windows.net`.
 *
 * @returns The blob service base URL (no trailing slash).
 */
export function getBlobServiceBaseUrl(): string {
  const config = getStorageConfig();
  if (config.blobServiceUrl) {
    // Remove trailing slash if present for consistent URL composition
    return config.blobServiceUrl.replace(/\/+$/, "");
  }
  return `https://${config.accountName}.blob.core.windows.net`;
}

/**
 * Reset the cached config singleton.
 * **Only for use in tests** — allows re-reading env vars between test cases.
 * @internal
 */
export function _resetConfigForTesting(): void {
  _config = null;
}
