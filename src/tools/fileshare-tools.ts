/**
 * Azure File Share MCP tools — 10 tools.
 *
 * Provides share management (list, create, delete), directory management
 * (create with nested parents, delete), listing (files + subdirectories),
 * file CRUD (upload, read/download, delete), and property inspection.
 *
 * File content is transferred as base64 strings within JSON, the same as
 * blob tools. Use `util-to-base64` / `util-from-base64` for text encoding.
 *
 * Unlike Blob Storage, File Share uses a true hierarchical directory structure.
 * Directories must exist before files can be created in them, but the upload
 * tool automatically creates missing parent directories.
 *
 * @module tools/fileshare-tools
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ShareServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-file-share";
import { getStorageConfig } from "../config.js";

/**
 * Register all 10 File Share tools on the given MCP server.
 *
 * Creates a singleton ShareServiceClient that reuses the internal HTTP
 * connection pool across all tool invocations.
 */
export function registerFileShareTools(server: McpServer): void {
  const config = getStorageConfig();

  // Singleton client — shared across all file share tool calls for connection reuse.
  const credential = new StorageSharedKeyCredential(
    config.accountName,
    config.accountKey
  );
  const shareServiceClient = new ShareServiceClient(
    `https://${config.accountName}.file.core.windows.net`,
    credential
  );

  // ── SHARE MANAGEMENT ─────────────────────────────────────────────────────

  server.tool(
    "fileshare-list-shares",
    "List all Azure file shares in the storage account. Use this to discover available shares before performing file operations. Returns an array of objects with 'name' and 'properties' (quota, last modified, etc.) for each share.",
    {},
    async () => {
      const client = shareServiceClient;
      const shares: { name: string; properties: Record<string, unknown> }[] = [];
      for await (const share of client.listShares()) {
        shares.push({
          name: share.name,
          properties: share.properties as unknown as Record<string, unknown>,
        });
      }
      return {
        content: [{ type: "text", text: JSON.stringify(shares, null, 2) }],
      };
    }
  );

  server.tool(
    "fileshare-create-share",
    "Create a new Azure file share if it doesn't already exist. Idempotent — safe to call even if the share already exists. Use this before uploading files to a new share.",
    {
      shareName: z.string().describe("File share name (lowercase letters, digits, and hyphens, 3-63 chars, e.g. 'project-documents')"),
    },
    async ({ shareName }) => {
      const client = shareServiceClient;
      const shareClient = client.getShareClient(shareName);
      const exists = await shareClient.exists();
      if (!exists) {
        await shareClient.create();
        return {
          content: [
            { type: "text", text: `Share "${shareName}" created successfully.` },
          ],
        };
      }
      return {
        content: [
          { type: "text", text: `Share "${shareName}" already exists.` },
        ],
      };
    }
  );

  server.tool(
    "fileshare-delete-share",
    "Permanently delete a file share and ALL files and directories inside it. WARNING: This is irreversible — all data in the share will be lost.",
    {
      shareName: z.string().describe("Name of the file share to delete (e.g. 'project-documents')"),
    },
    async ({ shareName }) => {
      const client = shareServiceClient;
      const shareClient = client.getShareClient(shareName);
      await shareClient.delete();
      return {
        content: [
          { type: "text", text: `Share "${shareName}" deleted.` },
        ],
      };
    }
  );

  // ── DIRECTORY MANAGEMENT ─────────────────────────────────────────────────
  // File shares use a real hierarchical directory structure (unlike blob
  // storage, which only has virtual directories via name prefixes).

  server.tool(
    "fileshare-create-directory",
    "Create a directory (and any missing parent directories) within a file share. Idempotent — existing directories are skipped. Use this to set up a folder structure before uploading files, or let 'fileshare-upload-file' auto-create directories on demand.",
    {
      shareName: z.string().describe("Name of the file share (e.g. 'project-documents')"),
      directoryPath: z
        .string()
        .describe("Forward-slash-separated directory path to create, including any nested levels (e.g. 'reports/2024/q1')"),
    },
    async ({ shareName, directoryPath }) => {
      const client = shareServiceClient;
      const shareClient = client.getShareClient(shareName);

      // Create each level of the directory path
      const parts = directoryPath.split("/").filter((p) => p.length > 0);
      let currentPath = "";
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const dirClient = shareClient.getDirectoryClient(currentPath);
        const exists = await dirClient.exists();
        if (!exists) {
          await dirClient.create();
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              directoryPath,
              message: `Directory path "${directoryPath}" ensured.`,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "fileshare-delete-directory",
    "Delete a directory from a file share. The directory MUST be empty — delete all files and subdirectories inside it first, or the operation will fail. Use 'fileshare-list' to check contents before deleting.",
    {
      shareName: z.string().describe("Name of the file share (e.g. 'project-documents')"),
      directoryPath: z.string().describe("Path of the directory to delete (e.g. 'reports/2024/q1')"),
    },
    async ({ shareName, directoryPath }) => {
      const client = shareServiceClient;
      const dirClient = client
        .getShareClient(shareName)
        .getDirectoryClient(directoryPath);
      await dirClient.delete();
      return {
        content: [
          {
            type: "text",
            text: `Directory "${directoryPath}" deleted from share "${shareName}".`,
          },
        ],
      };
    }
  );

  // ── LIST FILES & DIRECTORIES ─────────────────────────────────────────────

  server.tool(
    "fileshare-list",
    "List all files and subdirectories within a directory of a file share. Use this to browse share contents or verify files exist before reading/deleting. Returns JSON with 'shareName', 'directoryPath', and 'items' — each item has 'name', 'kind' ('file' or 'directory'), and for files: 'contentLength' (bytes) and 'lastModified'.",
    {
      shareName: z.string().describe("Name of the file share (e.g. 'project-documents')"),
      directoryPath: z
        .string()
        .optional()
        .default("")
        .describe("Directory path to list (e.g. 'reports/2024'), or empty string for the share root"),
    },
    async ({ shareName, directoryPath }) => {
      const client = shareServiceClient;
      const shareClient = client.getShareClient(shareName);
      const dirClient =
        directoryPath && directoryPath !== ""
          ? shareClient.getDirectoryClient(directoryPath)
          : shareClient.rootDirectoryClient;

      const items: {
        name: string;
        kind: "file" | "directory";
        contentLength?: number;
        lastModified?: Date;
      }[] = [];

      for await (const entity of dirClient.listFilesAndDirectories()) {
        if (entity.kind === "directory") {
          items.push({ name: entity.name, kind: "directory" });
        } else {
          items.push({
            name: entity.name,
            kind: "file",
            contentLength: entity.properties?.contentLength,
            lastModified: entity.properties?.lastModified,
          });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { shareName, directoryPath: directoryPath || "/", items },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── FILE CRUD ────────────────────────────────────────────────────────────
  // Content is transferred as base64 within JSON. The upload tool auto-creates
  // parent directories. Azure File Share requires two API calls per upload:
  // create (allocate size) then uploadRange (write data).

  server.tool(
    "fileshare-upload-file",
    "Upload a file to a directory in a file share. Content must be base64-encoded — use 'util-to-base64' to encode text content first. Automatically creates parent directories if they don't exist. Overwrites the file if it already exists. Returns JSON with 'success', 'shareName', 'directoryPath', 'fileName', and 'size' (bytes).",
    {
      shareName: z.string().describe("Name of the file share (e.g. 'project-documents')"),
      directoryPath: z
        .string()
        .describe("Target directory path (e.g. 'reports/2024'), or '.' for the share root"),
      fileName: z.string().describe("File name with extension (e.g. 'q1-summary.pdf')"),
      contentBase64: z.string().describe("File content encoded as a base64 string. Use 'util-to-base64' to convert text, or provide raw base64 for binary files."),
    },
    async ({ shareName, directoryPath, fileName, contentBase64 }) => {
      const client = shareServiceClient;
      const shareClient = client.getShareClient(shareName);

      // Ensure directory exists
      let dirClient;
      if (!directoryPath || directoryPath === "." || directoryPath === "") {
        dirClient = shareClient.rootDirectoryClient;
      } else {
        dirClient = shareClient.getDirectoryClient(directoryPath);
        const dirExists = await dirClient.exists();
        if (!dirExists) {
          // Create nested directories
          const parts = directoryPath.split("/").filter((p) => p.length > 0);
          let currentPath = "";
          for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const tempDir = shareClient.getDirectoryClient(currentPath);
            const exists = await tempDir.exists();
            if (!exists) {
              await tempDir.create();
            }
          }
          dirClient = shareClient.getDirectoryClient(directoryPath);
        }
      }

      // Upload the file
      const fileClient = dirClient.getFileClient(fileName);
      const buffer = Buffer.from(contentBase64, "base64");
      await fileClient.create(buffer.length);
      await fileClient.uploadRange(buffer, 0, buffer.length);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              shareName,
              directoryPath,
              fileName,
              size: buffer.length,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "fileshare-read-file",
    "Download a file from a file share and return its content as base64. Use 'util-from-base64' to decode text content after downloading. Returns JSON with 'shareName', 'directoryPath', 'fileName', 'size' (bytes), 'contentType', and 'contentBase64'.",
    {
      shareName: z.string().describe("Name of the file share (e.g. 'project-documents')"),
      directoryPath: z
        .string()
        .describe("Directory containing the file (e.g. 'reports/2024'), or '.' for the share root"),
      fileName: z.string().describe("Name of the file to read (e.g. 'q1-summary.pdf')"),
    },
    async ({ shareName, directoryPath, fileName }) => {
      const client = shareServiceClient;
      const shareClient = client.getShareClient(shareName);

      const dirClient =
        !directoryPath || directoryPath === "." || directoryPath === ""
          ? shareClient.rootDirectoryClient
          : shareClient.getDirectoryClient(directoryPath);

      const fileClient = dirClient.getFileClient(fileName);
      const downloadResponse = await fileClient.download();
      const buffer = await streamToBuffer(
        downloadResponse.readableStreamBody!
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              shareName,
              directoryPath,
              fileName,
              size: buffer.length,
              contentType: downloadResponse.contentType,
              contentBase64: buffer.toString("base64"),
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "fileshare-delete-file",
    "Permanently delete a file from a file share. WARNING: This is irreversible. Returns JSON with 'success' and the full path of the deleted file.",
    {
      shareName: z.string().describe("Name of the file share (e.g. 'project-documents')"),
      directoryPath: z
        .string()
        .describe("Directory containing the file (e.g. 'reports/2024'), or '.' for the share root"),
      fileName: z.string().describe("Name of the file to delete (e.g. 'q1-summary.pdf')"),
    },
    async ({ shareName, directoryPath, fileName }) => {
      const client = shareServiceClient;
      const shareClient = client.getShareClient(shareName);

      const dirClient =
        !directoryPath || directoryPath === "." || directoryPath === ""
          ? shareClient.rootDirectoryClient
          : shareClient.getDirectoryClient(directoryPath);

      const fileClient = dirClient.getFileClient(fileName);
      await fileClient.delete();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              deleted: `${directoryPath}/${fileName}`,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "fileshare-get-file-properties",
    "Get detailed properties and metadata for a specific file in a file share without downloading its content. Use this to check file size, content type, timestamps, and custom metadata. Returns JSON with 'fileName', 'contentLength' (bytes), 'contentType', 'lastModified', 'createdOn', and 'metadata'.",
    {
      shareName: z.string().describe("Name of the file share (e.g. 'project-documents')"),
      directoryPath: z
        .string()
        .describe("Directory containing the file (e.g. 'reports/2024'), or '.' for the share root"),
      fileName: z.string().describe("Name of the file to inspect (e.g. 'q1-summary.pdf')"),
    },
    async ({ shareName, directoryPath, fileName }) => {
      const client = shareServiceClient;
      const shareClient = client.getShareClient(shareName);

      const dirClient =
        !directoryPath || directoryPath === "." || directoryPath === ""
          ? shareClient.rootDirectoryClient
          : shareClient.getDirectoryClient(directoryPath);

      const fileClient = dirClient.getFileClient(fileName);
      const props = await fileClient.getProperties();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                fileName,
                contentLength: props.contentLength,
                contentType: props.contentType,
                lastModified: props.lastModified,
                createdOn: props.fileCreatedOn,
                metadata: props.metadata,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

/**
 * Collect a Node.js readable stream into a single Buffer.
 * Used to download file content before base64-encoding it.
 *
 * @param readableStream - The stream from a file download response.
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
