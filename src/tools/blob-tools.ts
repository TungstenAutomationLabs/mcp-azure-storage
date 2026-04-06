import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  ContainerSASPermissions,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
} from "@azure/storage-blob";
import { getStorageConfig } from "../config.js";

export function registerBlobTools(server: McpServer): void {
  const config = getStorageConfig();

  function getBlobServiceClient(): BlobServiceClient {
    const credential = new StorageSharedKeyCredential(
      config.accountName,
      config.accountKey
    );
    return new BlobServiceClient(
      `https://${config.accountName}.blob.core.windows.net`,
      credential
    );
  }

  // ──────────────────────────────────────────────────────────────
  // CONTAINER OPERATIONS
  // ──────────────────────────────────────────────────────────────

  server.tool(
    "blob-container-list",
    "List all blob containers in the storage account",
    {},
    async () => {
      const client = getBlobServiceClient();
      const containers: { name: string; lastModified?: Date }[] = [];
      for await (const container of client.listContainers()) {
        containers.push({
          name: container.name,
          lastModified: container.properties.lastModified,
        });
      }
      return {
        content: [{ type: "text", text: JSON.stringify(containers, null, 2) }],
      };
    }
  );

  server.tool(
    "blob-container-create",
    "Create a blob container if it doesn't already exist",
    {
      containerName: z
        .string()
        .regex(/^[a-z0-9](-*[a-z0-9])*$/)
        .describe("Container name (lowercase, numbers, hyphens only)"),
    },
    async ({ containerName }) => {
      const client = getBlobServiceClient();
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
    "Delete a blob container",
    {
      containerName: z.string().describe("Container name to delete"),
    },
    async ({ containerName }) => {
      const client = getBlobServiceClient();
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
    "Check if a blob container exists",
    {
      containerName: z.string().describe("Container name to check"),
    },
    async ({ containerName }) => {
      const client = getBlobServiceClient();
      const containerClient = client.getContainerClient(containerName);
      const exists = await containerClient.exists();
      return {
        content: [{ type: "text", text: JSON.stringify({ exists }) }],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────
  // BLOB CRUD OPERATIONS
  // ──────────────────────────────────────────────────────────────

  server.tool(
    "blob-list",
    "List blobs in a container, optionally filtered by directory prefix. Returns name, size, dates, content type, and custom metadata.",
    {
      containerName: z.string().describe("Container name"),
      directory: z
        .string()
        .optional()
        .default(".")
        .describe("Directory prefix to filter by, or '.' for root"),
      includeMetadata: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include custom metadata in results"),
    },
    async ({ containerName, directory, includeMetadata }) => {
      const client = getBlobServiceClient();
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
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  server.tool(
    "blob-create",
    "Create or overwrite a blob. Content is provided as base64. Optionally attach custom metadata.",
    {
      containerName: z.string().describe("Container name"),
      blobName: z
        .string()
        .describe("Blob name including any virtual directory path"),
      contentBase64: z.string().describe("File content as base64 string"),
      metadata: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional custom metadata key-value pairs"),
    },
    async ({ containerName, blobName, contentBase64, metadata }) => {
      const client = getBlobServiceClient();
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              blobName,
              contentType,
              size: buffer.length,
              metadataSet: metadata ? Object.keys(metadata).length : 0,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "blob-read",
    "Read a blob and return its content as base64",
    {
      containerName: z.string().describe("Container name"),
      blobName: z.string().describe("Blob name including path"),
      returnUrl: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, return a SAS URL instead of base64 content"),
      sasExpiryHours: z
        .number()
        .optional()
        .default(24)
        .describe("SAS token expiry in hours (only used if returnUrl is true)"),
    },
    async ({ containerName, blobName, returnUrl, sasExpiryHours }) => {
      const client = getBlobServiceClient();
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
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ url, expiresInHours: sasExpiryHours }),
            },
          ],
        };
      }

      // Return base64 content
      const blobClient = containerClient.getBlobClient(blobName);
      const downloadResponse = await blobClient.download();
      const buffer = await streamToBuffer(
        downloadResponse.readableStreamBody!
      );
      const base64 = buffer.toString("base64");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              blobName,
              contentType: downloadResponse.contentType,
              size: buffer.length,
              contentBase64: base64,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "blob-delete",
    "Delete a blob and its snapshots",
    {
      containerName: z.string().describe("Container name"),
      blobName: z.string().describe("Blob name including path"),
    },
    async ({ containerName, blobName }) => {
      const client = getBlobServiceClient();
      const containerClient = client.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.delete({ deleteSnapshots: "include" });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, deleted: blobName }),
          },
        ],
      };
    }
  );

  server.tool(
    "blob-set-metadata",
    "Set or update custom metadata on an existing blob",
    {
      containerName: z.string().describe("Container name"),
      blobName: z.string().describe("Blob name"),
      metadata: z
        .record(z.string(), z.string())
        .describe("Metadata key-value pairs to set"),
    },
    async ({ containerName, blobName, metadata }) => {
      const client = getBlobServiceClient();
      const containerClient = client.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);
      await blobClient.setMetadata(metadata);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              blobName,
              metadataKeys: Object.keys(metadata),
            }),
          },
        ],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────
  // SAS TOKEN OPERATIONS
  // ──────────────────────────────────────────────────────────────

  server.tool(
    "blob-get-sas-url",
    "Generate a SAS URL for a specific blob for instant access",
    {
      containerName: z.string().describe("Container name"),
      blobName: z.string().describe("Blob name"),
      expiryHours: z
        .number()
        .optional()
        .default(24)
        .describe("Hours until SAS expires"),
      permissions: z
        .string()
        .optional()
        .default("r")
        .describe("SAS permissions string (r=read, w=write, d=delete, l=list)"),
    },
    async ({ containerName, blobName, expiryHours, permissions }) => {
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
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ url, sasToken, expiresOn: expiresOn.toISOString() }),
          },
        ],
      };
    }
  );

  server.tool(
    "blob-get-container-sas",
    "Generate a SAS token for an entire container",
    {
      containerName: z.string().describe("Container name"),
      expiryHours: z.number().optional().default(24).describe("Hours until SAS expires"),
      permissions: z
        .string()
        .optional()
        .default("rl")
        .describe("SAS permissions (r=read, l=list, w=write, d=delete)"),
    },
    async ({ containerName, expiryHours, permissions }) => {
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              sasToken,
              connectionString,
              containerName,
              expiresOn: expiresOn.toISOString(),
            }),
          },
        ],
      };
    }
  );
}

// ──────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ──────────────────────────────────────────────────────────────

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
