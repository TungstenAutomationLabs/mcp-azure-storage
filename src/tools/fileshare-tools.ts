import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ShareServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-file-share";
import { getStorageConfig } from "../config.js";

export function registerFileShareTools(server: McpServer): void {
  const config = getStorageConfig();

  function getShareServiceClient(): ShareServiceClient {
    const credential = new StorageSharedKeyCredential(
      config.accountName,
      config.accountKey
    );
    return new ShareServiceClient(
      `https://${config.accountName}.file.core.windows.net`,
      credential
    );
  }

  // ── SHARE MANAGEMENT ──

  server.tool(
    "fileshare-list-shares",
    "List all file shares in the storage account",
    {},
    async () => {
      const client = getShareServiceClient();
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
    "Create a file share if it doesn't exist",
    {
      shareName: z.string().describe("File share name"),
    },
    async ({ shareName }) => {
      const client = getShareServiceClient();
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
    "Delete a file share",
    {
      shareName: z.string().describe("File share name to delete"),
    },
    async ({ shareName }) => {
      const client = getShareServiceClient();
      const shareClient = client.getShareClient(shareName);
      await shareClient.delete();
      return {
        content: [
          { type: "text", text: `Share "${shareName}" deleted.` },
        ],
      };
    }
  );

  // ── DIRECTORY MANAGEMENT ──

  server.tool(
    "fileshare-create-directory",
    "Create a directory within a file share (creates parent directories if needed)",
    {
      shareName: z.string().describe("File share name"),
      directoryPath: z
        .string()
        .describe("Directory path to create (e.g. 'reports/2024/q1')"),
    },
    async ({ shareName, directoryPath }) => {
      const client = getShareServiceClient();
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
    "Delete a directory (must be empty)",
    {
      shareName: z.string().describe("File share name"),
      directoryPath: z.string().describe("Directory path to delete"),
    },
    async ({ shareName, directoryPath }) => {
      const client = getShareServiceClient();
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

  // ── LIST FILES & DIRECTORIES ──

  server.tool(
    "fileshare-list",
    "List files and subdirectories in a file share directory",
    {
      shareName: z.string().describe("File share name"),
      directoryPath: z
        .string()
        .optional()
        .default("")
        .describe("Directory path, or empty string for root"),
    },
    async ({ shareName, directoryPath }) => {
      const client = getShareServiceClient();
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

  // ── FILE CRUD ──

  server.tool(
    "fileshare-upload-file",
    "Upload a file to a file share. Content is provided as base64. Directory is created if it doesn't exist.",
    {
      shareName: z.string().describe("File share name"),
      directoryPath: z
        .string()
        .describe("Directory path, or '.' for root"),
      fileName: z.string().describe("File name with extension"),
      contentBase64: z.string().describe("File content as base64 string"),
    },
    async ({ shareName, directoryPath, fileName, contentBase64 }) => {
      const client = getShareServiceClient();
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
    "Read a file from a file share and return its content as base64",
    {
      shareName: z.string().describe("File share name"),
      directoryPath: z
        .string()
        .describe("Directory path, or '.' for root"),
      fileName: z.string().describe("File name to read"),
    },
    async ({ shareName, directoryPath, fileName }) => {
      const client = getShareServiceClient();
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
    "Delete a file from a file share",
    {
      shareName: z.string().describe("File share name"),
      directoryPath: z
        .string()
        .describe("Directory path, or '.' for root"),
      fileName: z.string().describe("File name to delete"),
    },
    async ({ shareName, directoryPath, fileName }) => {
      const client = getShareServiceClient();
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
    "Get properties and metadata for a file",
    {
      shareName: z.string().describe("File share name"),
      directoryPath: z
        .string()
        .describe("Directory path, or '.' for root"),
      fileName: z.string().describe("File name"),
    },
    async ({ shareName, directoryPath, fileName }) => {
      const client = getShareServiceClient();
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

// Helper
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
