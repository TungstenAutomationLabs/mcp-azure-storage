export interface StorageConfig {
  accountName: string;
  accountKey: string;
  sasExpiryHours: number;
  sasDefaultPermissions: string;
}

let _config: StorageConfig | null = null;

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
