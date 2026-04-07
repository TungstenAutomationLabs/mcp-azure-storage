/**
 * @module fileshare-resources
 *
 * MCP Resource definitions for Azure File Share read-only operations.
 *
 * Exposes 4 resources:
 *   - `azure-fileshare:///shares`                                           — list all shares
 *   - `azure-fileshare:///shares/{shareName}/files/{directoryPath}`         — list files in dir
 *   - `azure-fileshare:///shares/{shareName}/file/{directoryPath}/{fileName}` — read file content
 *   - `azure-fileshare:///shares/{shareName}/properties/{directoryPath}/{fileName}` — file properties
 *
 * These resources complement the fileshare tools by providing a URI-addressable,
 * read-only interface that agents can use to provide LLM context without
 * invoking tool actions.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShareServiceClient, StorageSharedKeyCredential } from "@azure/storage-file-share";
import { getStorageConfig } from "../config.js";

// ── Singleton File Share Service Client ────────────────────────
const config = getStorageConfig();
const credential = new StorageSharedKeyCredential(config.accountName, config.accountKey);
const fileServiceUrl =
  config.fileServiceUrl || `https://${config.accountName}.file.core.windows.net`;
const shareServiceClient = new ShareServiceClient(fileServiceUrl, credential);

/** Maximum number of items returned by listing resources to prevent oversized responses. */
const MAX_LIST_ITEMS = 500;

/** Maximum file size (in bytes) that will be downloaded via the resource interface. */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB

/**
 * Registers all File Share MCP resources on the given server instance.
 *
 * @param server - The McpServer to register resources on.
 */
export function registerFileShareResources(server: McpServer): void {
  // ── 1. List Shares (static resource) ───────────────────────
  server.resource(
    "fileshare-shares",
    "azure-fileshare:///shares",
    {
      description: "List all file shares in the storage account. Use this as a starting point to discover which shares exist before browsing directories or reading files. Returns a JSON array of objects with 'name' (share name) and 'index' (1-based position).",
      mimeType: "application/json",
    },
    async (uri) => {
      const shares: { name: string; index: number }[] = [];
      let index = 1;
      for await (const share of shareServiceClient.listShares()) {
        shares.push({ name: share.name, index: index++ });
        if (index > MAX_LIST_ITEMS) break;
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(shares, null, 2),
          },
        ],
      };
    }
  );

  // ── 2. List Files in Directory (template resource) ─────────
  server.resource(
    "fileshare-list-files",
    new ResourceTemplate("azure-fileshare:///shares/{shareName}/files/{directoryPath}", {
      list: undefined, // Discover share names via the azure-fileshare:///shares static resource
    }),
    {
      description: "List files and directories within a specific directory of a file share. Use this to browse the hierarchical folder structure — set directoryPath to empty string for the root directory. Returns a JSON array of objects with 'name', 'type' ('file' or 'directory'), 'size' (bytes, files only), and 'index' (1-based). Navigate into subdirectories by using a returned directory name as the next directoryPath.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const shareName = String(variables.shareName);
      const directoryPath = String(variables.directoryPath || "");
      const shareClient = shareServiceClient.getShareClient(shareName);
      const dirClient = shareClient.getDirectoryClient(directoryPath);

      const items: { name: string; type: "file" | "directory"; size?: number; index: number }[] = [];
      let index = 1;
      for await (const entity of dirClient.listFilesAndDirectories()) {
        if (entity.kind === "directory") {
          items.push({ name: entity.name, type: "directory", index: index++ });
        } else {
          items.push({
            name: entity.name,
            type: "file",
            size: entity.properties.contentLength ?? 0,
            index: index++,
          });
        }
        if (index > MAX_LIST_ITEMS) break;
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(items, null, 2),
          },
        ],
      };
    }
  );

  // ── 3. Read File Content (template resource) ───────────────
  server.resource(
    "fileshare-read-file",
    new ResourceTemplate(
      "azure-fileshare:///shares/{shareName}/file/{directoryPath}/{fileName}",
      { list: undefined }
    ),
    {
      description: "Read the content of a specific file in a file share. Use this to retrieve file contents for analysis, summarisation, or processing. Text-based files (text/*, JSON, XML) are returned as UTF-8 text; binary files (images, PDFs, archives) are returned as base64-encoded strings. Requires shareName, directoryPath, and fileName — use the fileshare-shares and fileshare-list-files resources first to discover available paths.",
      mimeType: "application/octet-stream",
    },
    async (uri, variables) => {
      const shareName = String(variables.shareName);
      const directoryPath = String(variables.directoryPath || "");
      const fileName = String(variables.fileName);
      const shareClient = shareServiceClient.getShareClient(shareName);
      const dirClient = shareClient.getDirectoryClient(directoryPath);
      const fileClient = dirClient.getFileClient(fileName);

      // Check file size before downloading to prevent OOM on large files
      const props = await fileClient.getProperties();
      const size = props.contentLength ?? 0;
      if (size > MAX_DOWNLOAD_BYTES) {
        throw new Error(
          `File '${fileName}' is ${(size / 1024 / 1024).toFixed(1)} MiB which exceeds the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB resource download limit. Use the fileshare-read-file tool for larger files.`
        );
      }
      const downloadResponse = await fileClient.download(0);
      const body = downloadResponse.readableStreamBody;
      if (!body) {
        throw new Error(`No content returned for file '${fileName}'`);
      }
      const buffer = await streamToBuffer(body);
      const contentType = downloadResponse.contentType ?? "application/octet-stream";
      const isText = contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml");

      if (isText) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: contentType,
              text: buffer.toString("utf-8"),
            },
          ],
        };
      } else {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: contentType,
              blob: buffer.toString("base64"),
            },
          ],
        };
      }
    }
  );

  // ── 4. File Properties (template resource) ─────────────────
  server.resource(
    "fileshare-file-properties",
    new ResourceTemplate(
      "azure-fileshare:///shares/{shareName}/properties/{directoryPath}/{fileName}",
      { list: undefined }
    ),
    {
      description: "Get properties and metadata for a specific file in a file share. Use this to inspect file size, content type, timestamps, and custom metadata before deciding whether to read the full file content. Returns a JSON object with name, shareName, directoryPath, contentLength, contentType, lastModified, createdOn, lastWriteOn, and metadata fields.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const shareName = String(variables.shareName);
      const directoryPath = String(variables.directoryPath || "");
      const fileName = String(variables.fileName);
      const shareClient = shareServiceClient.getShareClient(shareName);
      const dirClient = shareClient.getDirectoryClient(directoryPath);
      const fileClient = dirClient.getFileClient(fileName);

      const properties = await fileClient.getProperties();
      const result = {
        name: fileName,
        shareName,
        directoryPath,
        contentLength: properties.contentLength,
        contentType: properties.contentType,
        lastModified: properties.lastModified,
        createdOn: properties.fileCreatedOn,
        lastWriteOn: properties.fileLastWriteOn,
        metadata: properties.metadata,
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}

/**
 * Collects a readable stream into a single Buffer.
 */
async function streamToBuffer(
  readableStream: NodeJS.ReadableStream
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    readableStream.on("data", (data: Buffer) => chunks.push(data));
    readableStream.on("end", () => resolve(Buffer.concat(chunks)));
    readableStream.on("error", reject);
  });
}
