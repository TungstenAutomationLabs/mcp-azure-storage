/**
 * Unit tests for src/config.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("getStorageConfig", () => {
  let originalName: string | undefined;
  let originalKey: string | undefined;
  let originalSasHours: string | undefined;
  let originalSasPerms: string | undefined;

  beforeEach(() => {
    originalName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    originalKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
    originalSasHours = process.env.SAS_EXPIRY_HOURS;
    originalSasPerms = process.env.SAS_DEFAULT_PERMISSIONS;
  });

  afterEach(async () => {
    // Restore env
    const restore = (key: string, val: string | undefined) => {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    };
    restore("AZURE_STORAGE_ACCOUNT_NAME", originalName);
    restore("AZURE_STORAGE_ACCOUNT_KEY", originalKey);
    restore("SAS_EXPIRY_HOURS", originalSasHours);
    restore("SAS_DEFAULT_PERMISSIONS", originalSasPerms);

    // Reset the singleton so next test re-reads env
    const { _resetConfigForTesting } = await import("../src/config.js");
    _resetConfigForTesting();
  });

  it("throws if AZURE_STORAGE_ACCOUNT_NAME is missing", async () => {
    delete process.env.AZURE_STORAGE_ACCOUNT_NAME;
    delete process.env.AZURE_STORAGE_ACCOUNT_KEY;

    // Reset cached config
    const { _resetConfigForTesting, getStorageConfig } = await import(
      "../src/config.js"
    );
    _resetConfigForTesting();

    expect(() => getStorageConfig()).toThrow("Missing required environment");
  });

  it("returns config with correct defaults", async () => {
    process.env.AZURE_STORAGE_ACCOUNT_NAME = "myaccount";
    process.env.AZURE_STORAGE_ACCOUNT_KEY = "bXlrZXk=";
    delete process.env.SAS_EXPIRY_HOURS;
    delete process.env.SAS_DEFAULT_PERMISSIONS;

    const { _resetConfigForTesting, getStorageConfig } = await import(
      "../src/config.js"
    );
    _resetConfigForTesting();

    const config = getStorageConfig();
    expect(config.accountName).toBe("myaccount");
    expect(config.accountKey).toBe("bXlrZXk=");
    expect(config.sasExpiryHours).toBe(24);
    expect(config.sasDefaultPermissions).toBe("rl");
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
    // Change env — should NOT affect the cached result
    process.env.AZURE_STORAGE_ACCOUNT_NAME = "changed";
    const second = getStorageConfig();

    expect(second.accountName).toBe("myaccount");
    expect(first).toBe(second); // same reference
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

    // Clean up
    delete process.env.AZURE_BLOB_SERVICE_URL;
    delete process.env.AZURE_QUEUE_SERVICE_URL;
  });
});
