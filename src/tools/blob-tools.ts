/**
 * Azure Blob Storage MCP tools — 11 tools.
 *
 * Provides container management (create, delete, exists), blob CRUD
 * (list, create/upload, read/download, delete, set-metadata), URL-based
 * upload (server-side fetch), and SAS token generation (blob-level and
 * container-level).
 *
 * Note: Container listing is provided by the `azure-blob:///containers`
 * MCP resource (see resources/blob-resources.ts).
 *
 * Content transfer modes:
 *  - `blob-create` — base64-encoded content in JSON (small files / text)
 *  - `blob-upload-from-url` — server fetches from a URL (large/binary files)
 *  - `POST /upload` — multipart form-data REST endpoint (see server.ts)
 *
 * @module tools/blob-tools
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatSchema, formatResponse } from "../utils/format.js";
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  ContainerSASPermissions,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
} from "@azure/storage-blob";
import { getStorageConfig } from "../config.js";

/**
 * Register all 11 Blob Storage tools on the given MCP server.
 *
 * Creates a singleton BlobServiceClient that reuses the internal HTTP
 * connection pool across all tool invocations for better performance.
 */
export function registerBlobTools(server: McpServer): void {
  const config = getStorageConfig();

  // Singleton client — created once, shared across all tool calls.
  // Azure SDK clients manage an internal HTTP pipeline with connection
  // pooling, retry policies, and telemetry. Reusing them avoids the
  // overhead of recreating these on every request.
  const credential = new StorageSharedKeyCredential(
    config.accountName,
    config.accountKey
  );
  const blobServiceUrl =
    config.blobServiceUrl || `https://${config.accountName}.blob.core.windows.net`;
  const blobServiceClient = new BlobServiceClient(blobServiceUrl, credential);

  // ──────────────────────────────────────────────────────────────
  // CONTAINER OPERATIONS
  // ──────────────────────────────────────────────────────────────

  server.tool(
    "blob-container-create",
    "Create a new blob container if it doesn't already exist. Use this before uploading blobs to a new container. Idempotent — safe to call even if the container already exists. Returns a confirmation message indicating whether the container was created or already existed.",
    {
      containerName: z
        .string()
        .regex(/^[a-z0-9](-*[a-z0-9])*$/)
        .describe("Container name (3-63 chars, lowercase letters, numbers, and hyphens only, e.g. 'my-data-2024'). Use 'util-to-container-name' to sanitise arbitrary text."),
    },
    async ({ containerName }) => {
      const client = blobServiceClient;
      const containerClient = client.getContainerClient(containerName);
      const exists = await containerClient.exists();
      if (!exists) {
        await containerClient.create();
        return {
          content: [
            {
              type: "text",
              text: `Container "${containerName}" created successfully.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Container "${containerName}" already exists.`,
          },
        ],
      };
    }
  );

  server.tool(
    "blob-container-delete",
    "Permanently delete a blob container and ALL blobs inside it. WARNING: This is irreversible — all data in the container will be lost. Use 'blob-container-exists' first to verify the container exists. Returns a confirmation or a message if the container was not found.",
    {
      containerName: z.string().describe("Name of the container to delete (e.g. 'my-data-2024')"),
    },
    async ({ containerName }) => {
      const client = blobServiceClient;
      const containerClient = client.getContainerClient(containerName);
      const exists = await containerClient.exists();
      if (exists) {
        await containerClient.delete();
        return {
          content: [
            {
              type: "text",
              text: `Container "${containerName}" deleted successfully.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Container "${containerName}" does not exist.`,
          },
        ],
      };
    }
  );

  server.tool(
    "blob-container-exists",
    "Check whether a blob container exists in the storage account. Use this to verify a container before attempting operations on it. Returns JSON with a boolean 'exists' field.",
    {
      containerName: z.string().describe("Name of the container to check (e.g. 'my-data-2024')"),
      format: formatSchema,
    },
    async ({ containerName, format }) => {
      const client = blobServiceClient;
      const containerClient = client.getContainerClient(containerName);
      const exists = await containerClient.exists();
      return formatResponse({ exists }, format, "Container Exists");
    }
  );

  // ──────────────────────────────────────────────────────────────
  // BLOB CRUD OPERATIONS
  // ──────────────────────────────────────────────────────────────

  server.tool(
    "blob-list",
    "List blobs in a container, optionally filtered by a virtual directory prefix. Use this to browse container contents or find blobs under a specific path. Returns an array of objects with 'name', 'contentLength' (bytes), 'contentType', 'createdOn', 'lastModified', and optionally 'metadata' for each blob. Only blobs with size > 0 are included (empty marker blobs are excluded).",
    {
      containerName: z.string().describe("Name of the container to list blobs from (e.g. 'my-data-2024')"),
      directory: z
        .string()
        .optional()
        .default(".")
        .describe("Virtual directory prefix to filter by (e.g. 'images/thumbnails/'), or '.' for the container root. Trailing slash is added automatically if missing."),
      includeMetadata: z
        .boolean()
        .optional()
        .default(true)
        .describe("When true, includes custom metadata key-value pairs in each result object"),
      format: formatSchema,
    },
    async ({ containerName, directory, includeMetadata, format }) => {
      const client = blobServiceClient;
      const containerClient = client.getContainerClient(containerName);

      const listOptions: {
        includeMetadata?: boolean;
        includeSnapshots?: boolean;
        includeTags?: boolean;
        prefix?: string;
      } = {
        includeMetadata,
        includeSnapshots: false,
        includeTags: true,
      };

      if (directory && directory !== "." && directory !== "") {
        listOptions.prefix = directory.endsWith("/")
          ? directory
          : directory + "/";
      }

      const results: {
        name: string;
        contentLength?: number;
        contentType?: string;
        createdOn?: Date;
        lastModified?: Date;
        metadata?: Record<string, string>;
      }[] = [];
      for await (const blob of containerClient.listBlobsFlat(listOptions)) {
        if (
          blob.properties.contentLength &&
          blob.properties.contentLength > 0
        ) {
          const item: {
            name: string;
            contentLength?: number;
            contentType?: string;
            createdOn?: Date;
            lastModified?: Date;
            metadata?: Record<string, string>;
          } = {
            name: blob.name,
            contentLength: blob.properties.contentLength,
            contentType: blob.properties.contentType,
            createdOn: blob.properties.createdOn,
            lastModified: blob.properties.lastModified,
          };
          if (includeMetadata && blob.metadata) {
            item.metadata = blob.metadata;
          }
          results.push(item);
        }
      }
      return formatResponse(results, format, "Blobs");
    }
  );

  server.tool(
    "blob-create",
    "Upload a new blob or overwrite an existing blob in a container. Content must be base64-encoded — use 'util-to-base64' to encode text content first. The MIME content type is auto-detected from the file extension. Returns JSON with 'success', 'blobName', 'contentType', 'size' (bytes), and 'metadataSet' (count of metadata keys).",
    {
      containerName: z.string().describe("Name of the target container (e.g. 'my-data-2024')"),
      blobName: z
        .string()
        .describe("Full blob name including any virtual directory path (e.g. 'reports/2024/q1-summary.pdf')"),
      contentBase64: z.string().describe("File content encoded as a base64 string. Use 'util-to-base64' to convert text, or provide raw base64 for binary files."),
      metadata: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional custom metadata as key-value string pairs (e.g. {\"author\": \"Alice\", \"department\": \"Sales\"})"),
      format: formatSchema,
    },
    async ({ containerName, blobName, contentBase64, metadata, format }) => {
      const client = blobServiceClient;
      const containerClient = client.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      const buffer = Buffer.from(contentBase64, "base64");
      const contentType = determineContentType(blobName);

      await blockBlobClient.uploadData(buffer, {
        blobHTTPHeaders: { blobContentType: contentType },
      });

      if (metadata && Object.keys(metadata).length > 0) {
        await blockBlobClient.setMetadata(metadata);
      }

      return formatResponse({
        success: true,
        blobName,
        contentType,
        size: buffer.length,
        metadataSet: metadata ? Object.keys(metadata).length : 0,
      }, format, "Blob Created");
    }
  );

  server.tool(
    "blob-read",
    "Download a blob's content. By default returns base64-encoded content (use 'util-from-base64' to decode text). Alternatively, set returnUrl=true to get a time-limited SAS URL for direct browser/client access instead of the raw content. Returns JSON with 'blobName', 'contentType', 'size', and either 'contentBase64' or 'url' depending on mode.",
    {
      containerName: z.string().describe("Name of the container holding the blob (e.g. 'my-data-2024')"),
      blobName: z.string().describe("Full blob name including virtual directory path (e.g. 'reports/2024/q1-summary.pdf')"),
      returnUrl: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, returns a time-limited SAS URL for direct HTTP access instead of downloading the blob content as base64"),
      sasExpiryHours: z
        .number()
        .optional()
        .default(24)
        .describe("Hours until the SAS URL expires (only used when returnUrl=true, default: 24)"),
      format: formatSchema,
    },
    async ({ containerName, blobName, returnUrl, sasExpiryHours, format }) => {
      const client = blobServiceClient;
      const containerClient = client.getContainerClient(containerName);

      if (returnUrl) {
        // Return a SAS URL for direct access
        const sasToken = generateBlobSas(
          config.accountName,
          config.accountKey,
          containerName,
          blobName,
          sasExpiryHours
        );
        const url = `https://${config.accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`;
        return formatResponse({ url, expiresInHours: sasExpiryHours }, format, "Blob SAS URL");
      }

      // Return base64 content
      const blobClient = containerClient.getBlobClient(blobName);
      const downloadResponse = await blobClient.download();
      const buffer = await streamToBuffer(
        downloadResponse.readableStreamBody!
      );
      const base64 = buffer.toString("base64");

      return formatResponse({
        blobName,
        contentType: downloadResponse.contentType,
        size: buffer.length,
        contentBase64: base64,
      }, format, "Blob Content");
    }
  );

  server.tool(
    "blob-delete",
    "Permanently delete a blob and all its snapshots from a container. WARNING: This is irreversible. Returns JSON with 'success' and the name of the deleted blob.",
    {
      containerName: z.string().describe("Name of the container holding the blob (e.g. 'my-data-2024')"),
      blobName: z.string().describe("Full blob name including virtual directory path (e.g. 'reports/2024/q1-summary.pdf')"),
      format: formatSchema,
    },
    async ({ containerName, blobName, format }) => {
      const client = blobServiceClient;
      const containerClient = client.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.delete({ deleteSnapshots: "include" });
      return formatResponse({ success: true, deleted: blobName }, format, "Blob Deleted");
    }
  );

  server.tool(
    "blob-set-metadata",
    "Set or replace all custom metadata on an existing blob. Note: this REPLACES all existing metadata — include any existing keys you want to keep. Use 'blob-list' with includeMetadata=true to read current metadata first. Returns JSON with 'success', 'blobName', and the list of metadata keys set.",
    {
      containerName: z.string().describe("Name of the container holding the blob (e.g. 'my-data-2024')"),
      blobName: z.string().describe("Full blob name including virtual directory path (e.g. 'reports/2024/q1-summary.pdf')"),
      metadata: z
        .record(z.string(), z.string())
        .describe("Metadata key-value string pairs to set (e.g. {\"author\": \"Alice\", \"status\": \"reviewed\"}). Replaces ALL existing metadata."),
      format: formatSchema,
    },
    async ({ containerName, blobName, metadata, format }) => {
      const client = blobServiceClient;
      const containerClient = client.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);
      await blobClient.setMetadata(metadata);
      return formatResponse({
        success: true,
        blobName,
        metadataKeys: Object.keys(metadata),
      }, format, "Metadata Updated");
    }
  );

  // ──────────────────────────────────────────────────────────────
  // SAS TOKEN OPERATIONS
  // ──────────────────────────────────────────────────────────────

  server.tool(
    "blob-get-sas-url",
    "Generate a time-limited SAS (Shared Access Signature) URL for a specific blob. Use this to grant temporary, scoped access to a blob without exposing storage account keys — ideal for sharing download links with external clients or embedding in web pages. Returns JSON with 'url' (the full SAS URL), 'sasToken', and 'expiresOn' (ISO 8601).",
    {
      containerName: z.string().describe("Name of the container holding the blob (e.g. 'my-data-2024')"),
      blobName: z.string().describe("Full blob name including virtual directory path (e.g. 'reports/2024/q1-summary.pdf')"),
      expiryHours: z
        .number()
        .optional()
        .default(24)
        .describe("Hours until the SAS token expires (default: 24)"),
      permissions: z
        .string()
        .optional()
        .default("r")
        .describe("SAS permissions string — combine: r=read, w=write, d=delete, l=list (default: 'r')"),
      format: formatSchema,
    },
    async ({ containerName, blobName, expiryHours, permissions, format }) => {
      const sasToken = generateBlobSas(
        config.accountName,
        config.accountKey,
        containerName,
        blobName,
        expiryHours,
        permissions
      );
      const url = `https://${config.accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`;
      const expiresOn = new Date();
      expiresOn.setHours(expiresOn.getHours() + expiryHours);
      return formatResponse({ url, sasToken, expiresOn: expiresOn.toISOString() }, format, "Blob SAS URL");
    }
  );

  server.tool(
    "blob-get-container-sas",
    "Generate a time-limited SAS token scoped to an entire container. Use this when you need to grant temporary access to list and read all blobs in a container — for example, to connect a client application or run a batch process. Returns JSON with 'sasToken', 'connectionString' (ready-to-use), 'containerName', and 'expiresOn' (ISO 8601).",
    {
      containerName: z.string().describe("Name of the container to generate the SAS for (e.g. 'my-data-2024')"),
      expiryHours: z.number().optional().default(24).describe("Hours until the SAS token expires (default: 24)"),
      permissions: z
        .string()
        .optional()
        .default("rl")
        .describe("SAS permissions string — combine: r=read, l=list, w=write, d=delete (default: 'rl')"),
      format: formatSchema,
    },
    async ({ containerName, expiryHours, permissions, format }) => {
      const expiresOn = new Date();
      expiresOn.setHours(expiresOn.getHours() + expiryHours);

      const credential = new StorageSharedKeyCredential(
        config.accountName,
        config.accountKey
      );
      const sasToken = generateBlobSASQueryParameters(
        {
          containerName,
          permissions: ContainerSASPermissions.parse(permissions),
          startsOn: new Date(),
          expiresOn,
          protocol: SASProtocol.HttpsAndHttp,
        },
        credential
      ).toString();

      const connectionString = `DefaultEndpointsProtocol=https;BlobEndpoint=https://${config.accountName}.blob.core.windows.net;SharedAccessSignature=${sasToken}`;

      return formatResponse({
        sasToken,
        connectionString,
        containerName,
        expiresOn: expiresOn.toISOString(),
      }, format, "Container SAS Token");
    }
  );

  // ──────────────────────────────────────────────────────────────
  // URL-BASED UPLOAD (server-side fetch — no base64 through LLM context)
  // ──────────────────────────────────────────────────────────────

  server.tool(
    "blob-upload-from-url",
    "Upload a file to blob storage by providing a URL. The MCP server fetches the file server-side, so no base64 encoding is needed — ideal for large or binary files (PDFs, images, etc.) that exceed LLM context limits. The URL must be publicly accessible or pre-authenticated (e.g. a SAS URL). Returns JSON with 'success', 'blobName', 'contentType', 'size' (bytes), and 'metadataSet'.",
    {
      containerName: z.string().describe("Name of the target container (e.g. 'my-data-2024')"),
      blobName: z
        .string()
        .describe("Full blob name including any virtual directory path (e.g. 'reports/2024/q1-summary.pdf')"),
      sourceUrl: z
        .string()
        .url()
        .describe("URL to fetch the file from. Must be publicly accessible or include authentication (e.g. a SAS URL). Supports http:// and https://."),
      metadata: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional custom metadata as key-value string pairs (e.g. {\"author\": \"Alice\", \"source\": \"external\"})"),
      format: formatSchema,
    },
    async ({ containerName, blobName, sourceUrl, metadata, format }) => {
      // ── SSRF protection ──
      // Validate the URL before fetching to prevent Server-Side Request Forgery.
      // An attacker with a valid API key could otherwise probe internal services:
      //   • Azure IMDS (169.254.169.254) — steal managed identity tokens
      //   • Internal VNet endpoints, Kubernetes API, etc.
      assertSafeUrl(sourceUrl);

      // Fetch the file from the source URL
      const response = await fetch(sourceUrl, { redirect: "error" });
      if (!response.ok) {
        throw new Error(
          `Failed to fetch from URL: ${response.status} ${response.statusText}`
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Use content-type from response if available, otherwise detect from blob name
      const contentType =
        response.headers.get("content-type")?.split(";")[0]?.trim() ||
        determineContentType(blobName);

      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      await blockBlobClient.uploadData(buffer, {
        blobHTTPHeaders: { blobContentType: contentType },
      });

      if (metadata && Object.keys(metadata).length > 0) {
        await blockBlobClient.setMetadata(metadata);
      }

      return formatResponse(
        {
          success: true,
          blobName,
          contentType,
          size: buffer.length,
          metadataSet: metadata ? Object.keys(metadata).length : 0,
        },
        format,
        "Blob Uploaded from URL"
      );
    }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS (module-private)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * SSRF protection — validate a URL before the server fetches it.
 *
 * Blocks requests to:
 *  - Azure Instance Metadata Service (IMDS): 169.254.169.254
 *  - Private/internal IP ranges (10.x, 172.16-31.x, 192.168.x)
 *  - Loopback (127.x, localhost, [::1])
 *  - Link-local (169.254.x)
 *  - Non-HTTP(S) schemes (file://, ftp://, etc.)
 *
 * @throws {Error} If the URL targets a blocked host or scheme.
 */
function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL format.");
  }

  // Only allow http/https schemes
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Blocked URL scheme "${parsed.protocol}" — only http: and https: are allowed.`
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost / loopback
  if (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname.startsWith("127.")
  ) {
    throw new Error("Blocked URL — loopback addresses are not allowed.");
  }

  // Block link-local (Azure IMDS lives at 169.254.169.254)
  if (hostname.startsWith("169.254.")) {
    throw new Error(
      "Blocked URL — link-local addresses (169.254.x.x) are not allowed."
    );
  }

  // Block private IP ranges (RFC 1918)
  if (
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw new Error("Blocked URL — private network addresses are not allowed.");
  }

  // Block 0.0.0.0 (all interfaces)
  if (hostname === "0.0.0.0") {
    throw new Error("Blocked URL — 0.0.0.0 is not allowed.");
  }
}

/**
 * Generate a SAS (Shared Access Signature) query string for a specific blob.
 *
 * @param accountName  - Storage account name.
 * @param accountKey   - Storage account shared key.
 * @param containerName - Target container.
 * @param blobName     - Target blob (including virtual directory path).
 * @param expiryHours  - Hours from now until the SAS token expires.
 * @param permissions  - SAS permission string (e.g. "r", "rwd").
 * @returns The SAS query string (without leading '?').
 */
function generateBlobSas(
  accountName: string,
  accountKey: string,
  containerName: string,
  blobName: string,
  expiryHours: number,
  permissions: string = "r"
): string {
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const expiresOn = new Date();
  expiresOn.setHours(expiresOn.getHours() + expiryHours);

  return generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse(permissions),
      startsOn: new Date(),
      expiresOn,
      protocol: SASProtocol.HttpsAndHttp,
    },
    credential
  ).toString();
}

/**
 * Collect a Node.js readable stream into a single Buffer.
 * Used to download blob content before base64-encoding it.
 *
 * @param readableStream - The stream from a blob download response.
 * @returns A Buffer containing the full stream contents.
 */
async function streamToBuffer(
  readableStream: NodeJS.ReadableStream
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    readableStream.on("data", (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on("end", () => resolve(Buffer.concat(chunks)));
    readableStream.on("error", reject);
  });
}

/**
 * Determine the MIME content type from a filename's extension.
 *
 * Extracts the extension from the last path segment, looks it up in a
 * static map of common types, and falls back to "application/octet-stream".
 *
 * @param filename - File name or path (e.g. "reports/summary.pdf").
 * @returns The MIME type string (e.g. "application/pdf").
 */
function determineContentType(filename: string): string {
  const extension = filename.split(/[/\\]/).pop()?.split(".").pop()?.toLowerCase() || "";
  const mimeTypes: Record<string, string> = {
    avi: "video/x-msvideo",
    bmp: "image/bmp",
    csv: "text/csv",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    gif: "image/gif",
    htm: "text/html",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "application/javascript",
    json: "application/json",
    mp4: "video/mp4",
    pdf: "application/pdf",
    png: "image/png",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    tif: "image/tiff",
    tiff: "image/tiff",
    txt: "text/plain",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xml: "application/xml",
  };
  return mimeTypes[extension] || "application/octet-stream";
}
