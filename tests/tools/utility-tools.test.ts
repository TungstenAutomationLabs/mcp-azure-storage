/**
 * Unit tests for src/tools/utility-tools.ts
 */


// ── Mock Azure Storage Blob SDK (for SAS tools) ─────────────────────────
vi.mock("@azure/storage-blob", () => {
  return {
    StorageSharedKeyCredential: vi.fn().mockImplementation(function() { return {}; }),
    generateBlobSASQueryParameters: vi.fn().mockReturnValue({
      toString: () => "sv=2023-01-01&sig=fakesig&spr=https",
    }),
    BlobSASPermissions: {
      parse: vi.fn().mockImplementation((perm: string) => {
        const validChars = /^[racwdxtmeopiyl]*$/;
        if (!validChars.test(perm)) {
          throw new Error(`Invalid permission character in "${perm}"`);
        }
        return {};
      }),
    },
    ContainerSASPermissions: {
      parse: vi.fn().mockImplementation((perm: string) => {
        const validChars = /^[racwdxltmeopiyl]*$/;
        if (!validChars.test(perm)) {
          throw new Error(`Invalid permission character in "${perm}"`);
        }
        return {};
      }),
    },
    SASProtocol: { HttpsAndHttp: "https,http", Https: "https" },
  };
});

import {
  createTestApp,
  mcpPost,
  toolCallRequest,
  toolListRequest,
  extractToolText,
  extractToolJson,
  extractToolsList,
} from "../helpers/mcp-test-harness.js";
import { registerUtilityTools } from "../../src/tools/utility-tools.js";
import { _resetConfigForTesting } from "../../src/config.js";
import { generateBlobSASQueryParameters } from "@azure/storage-blob";

function createUtilTestApp() {
  return createTestApp((server) => registerUtilityTools(server));
}

describe("utility-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tool registration", () => {
    it("registers 8 utility tools", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(app, toolListRequest()).expect(200);

      const tools = extractToolsList(res);
      expect(tools).toHaveLength(8);

      const names = tools.map((t: any) => t.name);
      expect(names).toContain("util-get-upload-url");
      expect(names).toContain("store-info");
    });
  });

  describe("util-to-base64", () => {
    it("encodes text to base64", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-to-base64", { text: "hello world" })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.base64).toBe(Buffer.from("hello world").toString("base64"));
      expect(data.originalLength).toBe(11);
    });
  });

  describe("util-from-base64", () => {
    it("decodes base64 to text", async () => {
      const base64 = Buffer.from("hello world").toString("base64");
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-from-base64", { base64 })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.text).toBe("hello world");
      expect(data.decodedLength).toBe(11);
    });
  });

  describe("util-get-content-type", () => {
    it("returns correct MIME type for known extensions", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-get-content-type", { fileName: "report.pdf" })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.contentType).toBe("application/pdf");
    });

    it("returns octet-stream for unknown extensions", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-get-content-type", { fileName: "data.xyz" })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.contentType).toBe("application/octet-stream");
    });
  });

  describe("util-to-container-name", () => {
    it("sanitises email to valid container name", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-to-container-name", {
          input: "Tom.Coppock@example.com",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.containerName).toBe("tom-coppock-example-com");
      expect(data.containerName).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it("applies prefix when provided", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-to-container-name", {
          input: "project",
          prefix: "user-",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.containerName).toBe("user-project");
    });

    it("pads short names to 3 characters", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-to-container-name", { input: "a" })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.containerName.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("util-refresh-blob-sas", () => {
    it("generates a fresh SAS URL", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-refresh-blob-sas", {
          containerName: "test",
          blobName: "file.txt",
        })
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.url).toContain("test/file.txt");
      expect(data.url).toContain("fakesig");
      expect(data.sasToken).toBeDefined();
      expect(data.expiresOn).toBeDefined();
    });

    // ── v1.1 Item 7: expiryMinutes with ceiling ────────────────────────
    describe("expiryMinutes and ceiling", () => {
      const savedEnv: Record<string, string | undefined> = {};

      beforeEach(() => {
        savedEnv.SAS_MAX_EXPIRY_MINUTES = process.env.SAS_MAX_EXPIRY_MINUTES;
        savedEnv.SAS_PROTOCOL = process.env.SAS_PROTOCOL;
        savedEnv.AZURE_BLOB_SERVICE_URL = process.env.AZURE_BLOB_SERVICE_URL;
      });

      afterEach(() => {
        for (const [key, val] of Object.entries(savedEnv)) {
          if (val !== undefined) process.env[key] = val;
          else delete process.env[key];
        }
        _resetConfigForTesting();
      });

      it("succeeds when expiryMinutes is within ceiling", async () => {
        process.env.SAS_MAX_EXPIRY_MINUTES = "60";
        _resetConfigForTesting();

        const app = createUtilTestApp();
        const res = await mcpPost(
          app,
          toolCallRequest("util-refresh-blob-sas", {
            containerName: "test",
            blobName: "file.txt",
            expiryMinutes: 30,
            permissions: "r",
          })
        ).expect(200);

        const data = extractToolJson(res);
        expect(data.url).toContain("test/file.txt");
        expect(data.sasToken).toBeDefined();
        expect(data.expiresOn).toBeDefined();
      });

      it("returns structured invalid error when expiryMinutes exceeds ceiling", async () => {
        process.env.SAS_MAX_EXPIRY_MINUTES = "30";
        _resetConfigForTesting();

        const app = createUtilTestApp();
        const res = await mcpPost(
          app,
          toolCallRequest("util-refresh-blob-sas", {
            containerName: "test",
            blobName: "file.txt",
            expiryMinutes: 60,
            permissions: "r",
          })
        ).expect(200);

        const text = extractToolText(res);
        expect(text).toContain("exceeds maximum");
        expect(text).toContain("30 minutes");
      });

      it("expiryMinutes takes precedence over expiryHours", async () => {
        process.env.SAS_MAX_EXPIRY_MINUTES = "1440";
        _resetConfigForTesting();

        const app = createUtilTestApp();
        const res = await mcpPost(
          app,
          toolCallRequest("util-refresh-blob-sas", {
            containerName: "test",
            blobName: "file.txt",
            expiryMinutes: 10,
            expiryHours: 24,
            permissions: "r",
          })
        ).expect(200);

        const data = extractToolJson(res);
        const expiresOn = new Date(data.expiresOn);
        const diffMs = expiresOn.getTime() - Date.now();
        // Should be roughly 10 minutes, definitely less than 1 hour
        expect(diffMs).toBeLessThan(60 * 60 * 1000);
        expect(diffMs).toBeGreaterThan(0);
      });
    });

    // ── v1.1 Item 7: SAS_PROTOCOL (spr query) ─────────────────────────
    describe("SAS protocol selection", () => {
      const savedEnv: Record<string, string | undefined> = {};

      beforeEach(() => {
        savedEnv.SAS_PROTOCOL = process.env.SAS_PROTOCOL;
      });

      afterEach(() => {
        if (savedEnv.SAS_PROTOCOL !== undefined) process.env.SAS_PROTOCOL = savedEnv.SAS_PROTOCOL;
        else delete process.env.SAS_PROTOCOL;
        _resetConfigForTesting();
      });

      it("passes SASProtocol.Https when SAS_PROTOCOL=https", async () => {
        process.env.SAS_PROTOCOL = "https";
        _resetConfigForTesting();

        const app = createUtilTestApp();
        await mcpPost(
          app,
          toolCallRequest("util-refresh-blob-sas", {
            containerName: "test",
            blobName: "file.txt",
            permissions: "r",
          })
        ).expect(200);

        expect(generateBlobSASQueryParameters).toHaveBeenCalledWith(
          expect.objectContaining({ protocol: "https" }),
          expect.anything()
        );
      });

      it("passes SASProtocol.HttpsAndHttp when SAS_PROTOCOL=https,http", async () => {
        process.env.SAS_PROTOCOL = "https,http";
        _resetConfigForTesting();

        const app = createUtilTestApp();
        await mcpPost(
          app,
          toolCallRequest("util-refresh-blob-sas", {
            containerName: "test",
            blobName: "file.txt",
            permissions: "r",
          })
        ).expect(200);

        expect(generateBlobSASQueryParameters).toHaveBeenCalledWith(
          expect.objectContaining({ protocol: "https,http" }),
          expect.anything()
        );
      });
    });

    // ── v1.1 Item 7: Permission validation ─────────────────────────────
    describe("permission validation", () => {
      it("returns structured invalid error for invalid permission characters", async () => {
        const app = createUtilTestApp();
        const res = await mcpPost(
          app,
          toolCallRequest("util-refresh-blob-sas", {
            containerName: "test",
            blobName: "file.txt",
            permissions: "xyz!",
          })
        ).expect(200);

        const text = extractToolText(res);
        expect(text).toContain("Invalid");
        expect(text).toContain("permissions");
      });

      it("accepts valid permission subsets (rwd)", async () => {
        const app = createUtilTestApp();
        const res = await mcpPost(
          app,
          toolCallRequest("util-refresh-blob-sas", {
            containerName: "test",
            blobName: "file.txt",
            permissions: "rwd",
          })
        ).expect(200);

        const data = extractToolJson(res);
        expect(data.url).toContain("test/file.txt");
        expect(data.sasToken).toBeDefined();
      });
    });

    // ── v1.1 Item 7: Endpoint host builder ─────────────────────────────
    describe("endpoint host builder", () => {
      const savedEnv: Record<string, string | undefined> = {};

      beforeEach(() => {
        savedEnv.AZURE_BLOB_SERVICE_URL = process.env.AZURE_BLOB_SERVICE_URL;
      });

      afterEach(() => {
        if (savedEnv.AZURE_BLOB_SERVICE_URL !== undefined) {
          process.env.AZURE_BLOB_SERVICE_URL = savedEnv.AZURE_BLOB_SERVICE_URL;
        } else {
          delete process.env.AZURE_BLOB_SERVICE_URL;
        }
        _resetConfigForTesting();
      });

      it("uses Azurite endpoint override in generated URL", async () => {
        process.env.AZURE_BLOB_SERVICE_URL = "http://127.0.0.1:10000/devstoreaccount1";
        _resetConfigForTesting();

        const app = createUtilTestApp();
        const res = await mcpPost(
          app,
          toolCallRequest("util-refresh-blob-sas", {
            containerName: "test",
            blobName: "file.txt",
            permissions: "r",
          })
        ).expect(200);

        const data = extractToolJson(res);
        expect(data.url).toContain("127.0.0.1:10000");
        expect(data.url).toContain("devstoreaccount1");
      });
    });
  
    // ══════════════════════════════════════════════════════════════════════════
    // store-info — v1.1 Item 8
    // ══════════════════════════════════════════════════════════════════════════
    describe("store-info", () => {
      const savedEnv: Record<string, string | undefined> = {};
      const envKeys = [
        "MAX_UPLOAD_BYTES",
        "MAX_JSON_BODY_BYTES",
        "SAS_MAX_EXPIRY_MINUTES",
        "SAS_PROTOCOL",
        "DISABLED_TOOLS",
        "AZURE_BLOB_SERVICE_URL",
        "AZURE_STORAGE_ACCOUNT_KEY",
        "AZURE_USE_MANAGED_IDENTITY",
      ];
  
      beforeEach(() => {
        for (const key of envKeys) {
          savedEnv[key] = process.env[key];
        }
      });
  
      afterEach(() => {
        for (const key of envKeys) {
          if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
          else delete process.env[key];
        }
        _resetConfigForTesting();
      });
  
      // ── Default outputs (no overrides) ────────────────────────────────────
      describe("default outputs", () => {
        it("returns correct default limits when env vars are unset", async () => {
          delete process.env.MAX_UPLOAD_BYTES;
          delete process.env.MAX_JSON_BODY_BYTES;
          delete process.env.SAS_MAX_EXPIRY_MINUTES;
          delete process.env.SAS_PROTOCOL;
          delete process.env.DISABLED_TOOLS;
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.ok).toBe(true);
          expect(data.limits.maxUploadBytes).toBe(5368709120);
          expect(data.limits.maxJsonBodyBytes).toBe(52428800);
          expect(data.limits.sasMaxExpiryMinutes).toBe(1440);
        });
  
        it("sas.protocol defaults to 'https'", async () => {
          delete process.env.SAS_PROTOCOL;
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.sas.protocol).toBe("https");
        });
  
        it("disabledTools is empty array when DISABLED_TOOLS is unset", async () => {
          delete process.env.DISABLED_TOOLS;
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.disabledTools).toEqual([]);
        });
  
        it("auth.mode is 'shared_key' when only account key is set", async () => {
          delete process.env.AZURE_USE_MANAGED_IDENTITY;
          process.env.AZURE_STORAGE_ACCOUNT_KEY =
            "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.auth.mode).toBe("shared_key");
          expect(data.auth.accountName).toBe("devstoreaccount1");
        });
  
        it("auth.mode is 'managed_identity' when only MI is enabled", async () => {
          process.env.AZURE_USE_MANAGED_IDENTITY = "true";
          delete process.env.AZURE_STORAGE_ACCOUNT_KEY;
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.auth.mode).toBe("managed_identity");
        });
  
        it("auth.mode is 'dual' when both MI and account key are set", async () => {
          process.env.AZURE_USE_MANAGED_IDENTITY = "true";
          process.env.AZURE_STORAGE_ACCOUNT_KEY =
            "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.auth.mode).toBe("dual");
        });
  
        it("endpoints.blobServiceUrl reflects Azurite override when configured", async () => {
          process.env.AZURE_BLOB_SERVICE_URL = "http://127.0.0.1:10000/devstoreaccount1";
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.endpoints.blobServiceUrl).toBe("http://127.0.0.1:10000/devstoreaccount1");
        });
  
        it("endpoints.blobServiceUrl uses default Azure URL when no override", async () => {
          delete process.env.AZURE_BLOB_SERVICE_URL;
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.endpoints.blobServiceUrl).toBe(
            "https://devstoreaccount1.blob.core.windows.net"
          );
        });
  
        it("capabilities has expected default values", async () => {
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.capabilities.versions).toBeNull();
          expect(data.capabilities.archiveTier).toBeNull();
          expect(data.capabilities.maxContainerConcurrency).toBe(4);
        });
      });
  
      // ── Environment overrides ─────────────────────────────────────────────
      describe("environment overrides", () => {
        it("reflects MAX_UPLOAD_BYTES override", async () => {
          process.env.MAX_UPLOAD_BYTES = "1048576";
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.limits.maxUploadBytes).toBe(1048576);
        });
  
        it("reflects MAX_JSON_BODY_BYTES override", async () => {
          process.env.MAX_JSON_BODY_BYTES = "2097152";
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.limits.maxJsonBodyBytes).toBe(2097152);
        });
  
        it("reflects SAS_MAX_EXPIRY_MINUTES override", async () => {
          process.env.SAS_MAX_EXPIRY_MINUTES = "60";
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.limits.sasMaxExpiryMinutes).toBe(60);
        });
  
        it("reflects SAS_PROTOCOL=https,http override (normalized)", async () => {
          process.env.SAS_PROTOCOL = "https,http";
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.sas.protocol).toBe("https,http");
        });
  
        it("normalizes SAS_PROTOCOL=http,https to 'https,http'", async () => {
          process.env.SAS_PROTOCOL = "http,https";
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.sas.protocol).toBe("https,http");
        });
  
        it("parses DISABLED_TOOLS case-insensitively and deduplicates", async () => {
          process.env.DISABLED_TOOLS = "Blob-List, blob-list, BLOB-CREATE, table-list";
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          // Should be lowercase, sorted, deduplicated
          expect(data.disabledTools).toEqual(["blob-create", "blob-list", "table-list"]);
        });
  
        it("handles single DISABLED_TOOLS entry", async () => {
          process.env.DISABLED_TOOLS = "  blob-delete  ";
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.disabledTools).toEqual(["blob-delete"]);
        });
      });
  
      // ── No sensitive fields ───────────────────────────────────────────────
      describe("security — no sensitive fields", () => {
        it("response contains exactly the documented top-level keys", async () => {
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          const topLevelKeys = Object.keys(data).sort();
          expect(topLevelKeys).toEqual([
            "auth",
            "capabilities",
            "disabledTools",
            "endpoints",
            "limits",
            "ok",
            "sas",
          ]);
        });
  
        it("does not expose account keys, SAS tokens, or connection strings", async () => {
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const text = extractToolText(res);
          const secretKeys = [
            "accountKey",
            "sasToken",
            "connectionString",
            "AZURE_STORAGE_ACCOUNT_KEY",
            "MCP_API_KEY",
            "secret",
            "password",
            "credential",
          ];
          for (const key of secretKeys) {
            expect(text.toLowerCase()).not.toContain(key.toLowerCase());
          }
        });
  
        it("auth object contains only mode and accountName", async () => {
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(Object.keys(data.auth).sort()).toEqual(["accountName", "mode"]);
        });
  
        it("limits object contains only expected keys", async () => {
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(Object.keys(data.limits).sort()).toEqual([
            "maxJsonBodyBytes",
            "maxUploadBytes",
            "sasMaxExpiryMinutes",
          ]);
        });
      });
  
      // ── Format handling ───────────────────────────────────────────────────
      describe("format handling", () => {
        it("returns JSON by default", async () => {
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", {})
          ).expect(200);
  
          const data = extractToolJson(res);
          expect(data.ok).toBe(true);
        });
  
        it("returns markdown when format=md", async () => {
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", { format: "md" })
          ).expect(200);
  
          const text = extractToolText(res);
          expect(text).toContain("### Store Info");
        });
  
        it("returns HTML when format=html", async () => {
          _resetConfigForTesting();
  
          const app = createUtilTestApp();
          const res = await mcpPost(
            app,
            toolCallRequest("store-info", { format: "html" })
          ).expect(200);
  
          const text = extractToolText(res);
          expect(text).toContain("mcp-");
          expect(text).toContain("Store Info");
        });
      });
    });
  });

  describe("util-get-upload-url", () => {
    it("returns upload endpoint URL and instructions", async () => {
      const app = createUtilTestApp();
      const res = await mcpPost(
        app,
        toolCallRequest("util-get-upload-url", {})
      ).expect(200);

      const data = extractToolJson(res);
      expect(data.uploadUrl).toContain("/upload");
      expect(data.method).toBe("POST");
      expect(data.contentType).toBe("multipart/form-data");
      expect(data.maxFileSize).toBe("100 MB");
      expect(data.fields).toBeDefined();
      expect(data.fields.file).toBeDefined();
      expect(data.fields.containerName).toBeDefined();
      expect(data.examples).toBeDefined();
      expect(data.examples.curl).toContain("/upload");
      expect(data.notes).toBeInstanceOf(Array);
    });
  });
});
