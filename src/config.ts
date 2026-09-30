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
 *  - `AZURE_BLOB_SERVICE_URL`     — override Blob service URL (for Azurite or emulator)
 *  - `AZURE_QUEUE_SERVICE_URL`    — override Queue service URL (for Azurite or emulator)
 *  - `AZURE_TABLE_SERVICE_URL`    — override Table service URL (for Azurite or emulator)
 *  - `AZURE_FILE_SERVICE_URL`     — override File Share service URL (for Azurite or emulator)
 *
 * @module config
 */

import { StorageSharedKeyCredential } from "@azure/storage-blob";
import type { TokenCredential } from "@azure/identity";

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

  _config = {
    accountName,
    accountKey,
    useManagedIdentity,
    sasExpiryHours: parseInt(process.env.SAS_EXPIRY_HOURS || "24", 10),
    sasDefaultPermissions: process.env.SAS_DEFAULT_PERMISSIONS || "rl",
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

/**
 * Reset the cached config singleton.
 * **Only for use in tests** — allows re-reading env vars between test cases.
 * @internal
 */
export function _resetConfigForTesting(): void {
  _config = null;
}
