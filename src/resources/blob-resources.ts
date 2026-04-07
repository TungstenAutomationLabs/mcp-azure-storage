/**
 * @module blob-resources
 *
 * MCP Resource definitions for Azure Blob Storage read-only operations.
 *
 * Exposes 4 resources:
 *   - `azure-blob:///containers`                             — list all containers
 *   - `azure-blob:///containers/{containerName}/properties`  — container metadata & properties
 *   - `azure-blob:///containers/{containerName}/blobs`       — list blobs in a container
 *   - `azure-blob:///containers/{containerName}/blobs/{blobName}` — read blob content
 *
 * These resources complement the blob tools by providing a URI-addressable,
 * read-only interface that agents can use to provide LLM context without
 * invoking tool actions.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { getStorageConfig } from "../config.js";

// ── Singleton Blob Service Client ──────────────────────────────
const config = getStorageConfig();
const credential = new StorageSharedKeyCredential(config.accountName, config.accountKey);
const blobServiceClient = new BlobServiceClient(
  `https://${config.accountName}.blob.core.windows.net`,
  credential
);

/** Maximum number of items returned by listing resources to prevent oversized responses. */
const MAX_LIST_ITEMS = 500;

/** Maximum blob size (in bytes) that will be downloaded via the resource interface. */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB

/**
 * Registers all Blob Storage MCP resources on the given server instance.
 *
 * @param server - The McpServer to register resources on.
 */
export function registerBlobResources(server: McpServer): void {
  // ── 1. List Containers (static resource) ───────────────────
  server.resource(
    "blob-containers",
    "azure-blob:///containers",
    {
      description: "List all blob containers in the storage account. Use this as a starting point to discover which containers exist before reading blobs or listing container contents. Returns a JSON array of objects with 'name' (container name) and 'index' (1-based position).",
      mimeType: "application/json",
    },
    async (uri) => {
      const containers: { name: string; index: number }[] = [];
      let index = 1;
      for await (const container of blobServiceClient.listContainers()) {
        containers.push({ name: container.name, index: index++ });
        if (index > MAX_LIST_ITEMS) break;
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(containers, null, 2),
          },
        ],
      };
    }
  );

  // ── 2. Container Properties (template resource) ────────────
  server.resource(
    "blob-container-properties",
    new ResourceTemplate("azure-blob:///containers/{containerName}/properties", {
      list: undefined, // Discover container names via the azure-blob:///containers static resource
    }),
    {
      description: "Get properties and metadata for a specific blob container. Use this to inspect container configuration (lease status, immutability policy, legal hold) or retrieve custom metadata before performing operations. Returns a JSON object with name, lastModified, leaseStatus, leaseState, hasImmutabilityPolicy, hasLegalHold, and metadata fields.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const containerName = String(variables.containerName);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const properties = await containerClient.getProperties();
      const result = {
        name: containerName,
        lastModified: properties.lastModified,
        leaseStatus: properties.leaseStatus,
        leaseState: properties.leaseState,
        hasImmutabilityPolicy: properties.hasImmutabilityPolicy,
        hasLegalHold: properties.hasLegalHold,
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

  // ── 3. List Blobs in Container (template resource) ─────────
  server.resource(
    "blob-list",
    new ResourceTemplate("azure-blob:///containers/{containerName}/blobs", {
      list: undefined, // Discover container names via the azure-blob:///containers static resource
    }),
    {
      description: "List all blobs in a specific container. Use this to discover blob names, sizes, and content types before reading individual blobs. Returns a JSON array of objects with 'name', 'size' (bytes), 'contentType', 'lastModified' (ISO 8601), and 'index' (1-based) for each blob.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const containerName = String(variables.containerName);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blobs: { name: string; size: number; contentType: string; lastModified: string; index: number }[] = [];
      let index = 1;
      for await (const blob of containerClient.listBlobsFlat({ includeMetadata: true })) {
        blobs.push({
          name: blob.name,
          size: blob.properties.contentLength ?? 0,
          contentType: blob.properties.contentType ?? "application/octet-stream",
          lastModified: blob.properties.lastModified?.toISOString() ?? "",
          index: index++,
        });
        if (index > MAX_LIST_ITEMS) break;
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(blobs, null, 2),
          },
        ],
      };
    }
  );

  // ── 4. Read Blob Content (template resource) ───────────────
  server.resource(
    "blob-read",
    new ResourceTemplate("azure-blob:///containers/{containerName}/blobs/{blobName}", {
      list: undefined, // Cannot enumerate all blobs across all containers efficiently
    }),
    {
      description: "Read the content of a specific blob. Use this to retrieve file contents for analysis, summarisation, or processing. Text-based blobs (text/*, JSON, XML) are returned as UTF-8 text; binary blobs (images, PDFs, archives) are returned as base64-encoded strings. Requires both containerName and blobName — use the blob-containers and blob-list resources first to discover available paths.",
      mimeType: "application/octet-stream",
    },
    async (uri, variables) => {
      const containerName = String(variables.containerName);
      const blobName = String(variables.blobName);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);
      // Check blob size before downloading to prevent OOM on large files
      const properties = await blobClient.getProperties();
      const size = properties.contentLength ?? 0;
      if (size > MAX_DOWNLOAD_BYTES) {
        throw new Error(
          `Blob '${blobName}' is ${(size / 1024 / 1024).toFixed(1)} MiB which exceeds the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB resource download limit. Use the blob-read tool with returnUrl=true to get a SAS URL instead.`
        );
      }
      const downloadResponse = await blobClient.download(0);
      const body = downloadResponse.readableStreamBody;
      if (!body) {
        throw new Error(`No content returned for blob '${blobName}'`);
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
