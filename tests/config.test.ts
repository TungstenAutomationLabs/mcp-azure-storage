/**
 * Unit tests for src/config.ts
 *
 * Tests both shared-key and managed-identity credential paths,
 * plus the validation / singleton behaviour of getStorageConfig().
 */


/** List of env vars touched by these tests — saved / restored in each run. */
const ENV_KEYS = [
  "AZURE_STORAGE_ACCOUNT_NAME",
  "AZURE_STORAGE_ACCOUNT_KEY",
  "AZURE_USE_MANAGED_IDENTITY",
  "SAS_EXPIRY_HOURS",
  "SAS_DEFAULT_PERMISSIONS",
  "AZURE_BLOB_SERVICE_URL",
  "AZURE_QUEUE_SERVICE_URL",
] as const;

describe("config", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
    const { _resetConfigForTesting } = await import("../src/config.js");
    _resetConfigForTesting();
  });

  // ── getStorageConfig ─────────────────────────────────────────────────────

  describe("getStorageConfig", () => {
    it("throws if AZURE_STORAGE_ACCOUNT_NAME is missing", async () => {
      delete process.env.AZURE_STORAGE_ACCOUNT_NAME;
      delete process.env.AZURE_STORAGE_ACCOUNT_KEY;

      const { _resetConfigForTesting, getStorageConfig } = await import(
        "../src/config.js"
      );
      _resetConfigForTesting();

      expect(() => getStorageConfig()).toThrow("Missing required environment");
    });

    it("throws if neither shared key nor managed identity is configured", async () => {
      process.env.AZURE_STORAGE_ACCOUNT_NAME = "myaccount";
      delete process.env.AZURE_STORAGE_ACCOUNT_KEY;
      delete process.env.AZURE_USE_MANAGED_IDENTITY;

      const { _resetConfigForTesting, getStorageConfig } = await import(
        "../src/config.js"
      );
      _resetConfigForTesting();

      expect(() => getStorageConfig()).toThrow("No credentials configured");
    });

    it("returns config with correct defaults (shared key)", async () => {
      process.env.AZURE_STORAGE_ACCOUNT_NAME = "myaccount";
      process.env.AZURE_STORAGE_ACCOUNT_KEY = "bXlrZXk=";
      delete process.env.SAS_EXPIRY_HOURS;
      delete process.env.SAS_DEFAULT_PERMISSIONS;
      delete process.env.AZURE_USE_MANAGED_IDENTITY;

      const { _resetConfigForTesting, getStorageConfig } = await import(
        "../src/config.js"
      );
      _resetConfigForTesting();

      const config = getStorageConfig();
      expect(config.accountName).toBe("myaccount");
      expect(config.accountKey).toBe("bXlrZXk=");
      expect(config.useManagedIdentity).toBe(false);
      expect(config.sasExpiryHours).toBe(24);
      expect(config.sasDefaultPermissions).toBe("rl");
    });

    it("sets useManagedIdentity when AZURE_USE_MANAGED_IDENTITY=true", async () => {
      process.env.AZURE_STORAGE_ACCOUNT_NAME = "myaccount";
      process.env.AZURE_USE_MANAGED_IDENTITY = "true";
      delete process.env.AZURE_STORAGE_ACCOUNT_KEY;

      const { _resetConfigForTesting, getStorageConfig } = await import(
        "../src/config.js"
      );
      _resetConfigForTesting();

      const config = getStorageConfig();
      expect(config.useManagedIdentity).toBe(true);
      expect(config.accountKey).toBe("");
    });

    it("accepts both shared key and managed identity together", async () => {
      process.env.AZURE_STORAGE_ACCOUNT_NAME = "myaccount";
      process.env.AZURE_STORAGE_ACCOUNT_KEY = "bXlrZXk=";
      process.env.AZURE_USE_MANAGED_IDENTITY = "true";

      const { _resetConfigForTesting, getStorageConfig } = await import(
        "../src/config.js"
      );
      _resetConfigForTesting();

      const config = getStorageConfig();
      expect(config.useManagedIdentity).toBe(true);
      expect(config.accountKey).toBe("bXlrZXk=");
    });

    it("reads optional SAS settings from env", async () => {
      process.env.AZURE_STORAGE_ACCOUNT_NAME = "myaccount";
      process.env.AZURE_STORAGE_ACCOUNT_KEY = "bXlrZXk=";
      process.env.SAS_EXPIRY_HOURS = "48";
      process.env.SAS_DEFAULT_PERMISSIONS = "rwdl";

      const { _resetConfigForTesting, getStorageConfig } = await import(
        "../src/config.js"
      );
      _resetConfigForTesting();

      const config = getStorageConfig();
      expect(config.sasExpiryHours).toBe(48);
      expect(config.sasDefaultPermissions).toBe("rwdl");
    });

    it("caches config on second call (singleton)", async () => {
      process.env.AZURE_STORAGE_ACCOUNT_NAME = "myaccount";
      process.env.AZURE_STORAGE_ACCOUNT_KEY = "bXlrZXk=";

      const { _resetConfigForTesting, getStorageConfig } = await import(
        "../src/config.js"
      );
      _resetConfigForTesting();

      const first = getStorageConfig();
      process.env.AZURE_STORAGE_ACCOUNT_NAME = "changed";
      const second = getStorageConfig();

      expect(second.accountName).toBe("myaccount");
      expect(first).toBe(second);
    });

    it("reads endpoint URL overrides when set", async () => {
      process.env.AZURE_STORAGE_ACCOUNT_NAME = "myaccount";
      process.env.AZURE_STORAGE_ACCOUNT_KEY = "bXlrZXk=";
      process.env.AZURE_BLOB_SERVICE_URL = "http://localhost:10000/myaccount";
      process.env.AZURE_QUEUE_SERVICE_URL = "http://localhost:10001/myaccount";

      const { _resetConfigForTesting, getStorageConfig } = await import(
        "../src/config.js"
      );
      _resetConfigForTesting();

      const config = getStorageConfig();
      expect(config.blobServiceUrl).toBe("http://localhost:10000/myaccount");
      expect(config.queueServiceUrl).toBe("http://localhost:10001/myaccount");
      expect(config.tableServiceUrl).toBeUndefined();
      expect(config.fileServiceUrl).toBeUndefined();
    });
  });

  // ── hasSharedKey ─────────────────────────────────────────────────────────

  describe("hasSharedKey", () => {
    it("returns true when account key is set", async () => {
      process.env.AZURE_STORAGE_ACCOUNT_NAME = "myaccount";
      process.env.AZURE_STORAGE_ACCOUNT_KEY = "bXlrZXk=";

      const { _resetConfigForTesting, hasSharedKey } = await import(
        "../src/config.js"
      );
      _resetConfigForTesting();

      expect(hasSharedKey()).toBe(true);
    });

    it("returns false in managed-identity-only mode (no key)", async () => {
      process.env.AZURE_STORAGE_ACCOUNT_NAME = "myaccount";
      process.env.AZURE_USE_MANAGED_IDENTITY = "true";
      delete process.env.AZURE_STORAGE_ACCOUNT_KEY;

      const { _resetConfigForTesting, hasSharedKey } = await import(
        "../src/config.js"
      );
      _resetConfigForTesting();

      expect(hasSharedKey()).toBe(false);
    });
  });

  // ── getSharedKeyCredential ───────────────────────────────────────────────

  describe("getSharedKeyCredential", () => {
    it("returns a StorageSharedKeyCredential when key is available", async () => {
      process.env.AZURE_STORAGE_ACCOUNT_NAME = "myaccount";
      process.env.AZURE_STORAGE_ACCOUNT_KEY = "bXlrZXk=";

      const { _resetConfigForTesting, getSharedKeyCredential } = await import(
        "../src/config.js"
      );
      _resetConfigForTesting();

      const cred = getSharedKeyCredential();
      expect(cred).toBeDefined();
      expect(cred.accountName).toBe("myaccount");
    });

    it("throws in managed-identity-only mode (no key)", async () => {
      process.env.AZURE_STORAGE_ACCOUNT_NAME = "myaccount";
      process.env.AZURE_USE_MANAGED_IDENTITY = "true";
      delete process.env.AZURE_STORAGE_ACCOUNT_KEY;

      const { _resetConfigForTesting, getSharedKeyCredential } = await import(
        "../src/config.js"
      );
      _resetConfigForTesting();

      expect(() => getSharedKeyCredential()).toThrow(
        "Shared key not available"
      );
    });
  });

  // ── getCredential ────────────────────────────────────────────────────────

  describe("getCredential", () => {
    it("returns StorageSharedKeyCredential in shared-key mode", async () => {
      process.env.AZURE_STORAGE_ACCOUNT_NAME = "myaccount";
      process.env.AZURE_STORAGE_ACCOUNT_KEY = "bXlrZXk=";
      delete process.env.AZURE_USE_MANAGED_IDENTITY;

      const { _resetConfigForTesting, getCredential } = await import(
        "../src/config.js"
      );
      _resetConfigForTesting();

      const cred = await getCredential();
      // StorageSharedKeyCredential exposes accountName
      expect((cred as any).accountName).toBe("myaccount");
    });

    it("returns DefaultAzureCredential in managed-identity mode", async () => {
      process.env.AZURE_STORAGE_ACCOUNT_NAME = "myaccount";
      process.env.AZURE_USE_MANAGED_IDENTITY = "true";
      delete process.env.AZURE_STORAGE_ACCOUNT_KEY;

      // Mock @azure/identity to avoid real credential discovery
      const mockDefaultAzureCredential = vi.fn().mockImplementation(function() { return {
        _isMockCredential: true,
      }; });
      vi.doMock("@azure/identity", () => ({
        DefaultAzureCredential: mockDefaultAzureCredential,
      }));

      const { _resetConfigForTesting, getCredential } = await import(
        "../src/config.js"
      );
      _resetConfigForTesting();

      const cred = await getCredential();
      expect((cred as any)._isMockCredential).toBe(true);
      expect(mockDefaultAzureCredential).toHaveBeenCalledTimes(1);

      vi.doUnmock("@azure/identity");
    });
  });
});
