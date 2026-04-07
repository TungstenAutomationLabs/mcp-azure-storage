/**
 * Azure Storage configuration singleton.
 *
 * Reads credentials and SAS defaults from environment variables on first
 * access, then caches the result for the lifetime of the process.
 *
 * Required environment variables:
 *  - `AZURE_STORAGE_ACCOUNT_NAME` — the storage account name (e.g. "mystorageaccount")
 *  - `AZURE_STORAGE_ACCOUNT_KEY`  — a base64-encoded account access key
 *
 * Optional environment variables:
 *  - `SAS_EXPIRY_HOURS`        — default SAS token lifetime in hours (default: 24)
 *  - `SAS_DEFAULT_PERMISSIONS`  — default SAS permission string (default: "rl")
 *
 * @module config
 */

/** Shape of the cached storage configuration. */
export interface StorageConfig {
  /** Azure Storage account name (e.g. "mystorageaccount"). */
  accountName: string;
  /** Base64-encoded shared key for the storage account. */
  accountKey: string;
  /** Default SAS token expiry in hours (from env or 24). */
  sasExpiryHours: number;
  /** Default SAS permission string (from env or "rl"). */
  sasDefaultPermissions: string;
}

/** Cached singleton — populated on first call to getStorageConfig(). */
let _config: StorageConfig | null = null;

/**
 * Return the storage configuration, reading from environment variables on
 * first call. Throws immediately if required variables are missing (fail-fast).
 *
 * @returns The cached StorageConfig singleton.
 * @throws {Error} If AZURE_STORAGE_ACCOUNT_NAME or AZURE_STORAGE_ACCOUNT_KEY is not set.
 */
export function getStorageConfig(): StorageConfig {
  if (_config) return _config;

  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

  if (!accountName || !accountKey) {
    throw new Error(
      "Missing required environment variables: AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_ACCOUNT_KEY"
    );
  }

  _config = {
    accountName,
    accountKey,
    sasExpiryHours: parseInt(process.env.SAS_EXPIRY_HOURS || "24", 10),
    sasDefaultPermissions: process.env.SAS_DEFAULT_PERMISSIONS || "rl",
  };

  return _config;
}
