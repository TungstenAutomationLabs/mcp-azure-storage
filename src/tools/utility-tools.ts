import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  ContainerSASPermissions,
  SASProtocol,
} from "@azure/storage-blob";
import { getStorageConfig } from "../config.js";

export function registerUtilityTools(server: McpServer): void {
  const config = getStorageConfig();

  // ── BASE64 CONVERSION ──

  server.tool(
    "util-to-base64",
    "Convert a text string (e.g. HTML document, JSON, plain text) to base64 encoding",
    {
      text: z.string().describe("The text content to encode as base64"),
      encoding: z
        .enum(["utf-8", "ascii", "latin1"])
        .optional()
        .default("utf-8")
        .describe("Source text encoding"),
    },
    async ({ text, encoding }) => {
      const base64 = Buffer.from(text, encoding as BufferEncoding).toString(
        "base64"
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              base64,
              originalLength: text.length,
              base64Length: base64.length,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "util-from-base64",
    "Decode a base64 string back to text (e.g. to read an HTML document or JSON from blob storage)",
    {
      base64: z.string().describe("The base64 encoded string to decode"),
      encoding: z
        .enum(["utf-8", "ascii", "latin1"])
        .optional()
        .default("utf-8")
        .describe("Target text encoding"),
    },
    async ({ base64, encoding }) => {
      const text = Buffer.from(base64, "base64").toString(
        encoding as BufferEncoding
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              text,
              base64Length: base64.length,
              decodedLength: text.length,
            }),
          },
        ],
      };
    }
  );

  // ── SAS TOKEN REFRESH ──

  server.tool(
    "util-refresh-blob-sas",
    "Generate a fresh SAS token for a specific blob. Use this to refresh an expired SAS URL.",
    {
      containerName: z.string().describe("Container name"),
      blobName: z.string().describe("Blob name including path"),
      expiryHours: z
        .number()
        .optional()
        .default(24)
        .describe("Hours until the new SAS expires"),
      permissions: z
        .string()
        .optional()
        .default("r")
        .describe("SAS permissions (r=read, w=write, d=delete, l=list)"),
    },
    async ({ containerName, blobName, expiryHours, permissions }) => {
      const credential = new StorageSharedKeyCredential(
        config.accountName,
        config.accountKey
      );
      const expiresOn = new Date();
      expiresOn.setHours(expiresOn.getHours() + expiryHours);

      const sasToken = generateBlobSASQueryParameters(
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

      const url = `https://${config.accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url,
              sasToken,
              expiresOn: expiresOn.toISOString(),
              permissions,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "util-refresh-container-sas",
    "Generate a fresh SAS token for an entire container. Returns both the token and a connection string.",
    {
      containerName: z.string().describe("Container name"),
      expiryHours: z
        .number()
        .optional()
        .default(24)
        .describe("Hours until the new SAS expires"),
      permissions: z
        .string()
        .optional()
        .default("rl")
        .describe("SAS permissions (r=read, l=list, w=write, d=delete)"),
    },
    async ({ containerName, expiryHours, permissions }) => {
      const credential = new StorageSharedKeyCredential(
        config.accountName,
        config.accountKey
      );
      const expiresOn = new Date();
      expiresOn.setHours(expiresOn.getHours() + expiryHours);

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
              containerName,
              sasToken,
              connectionString,
              expiresOn: expiresOn.toISOString(),
              permissions,
            }),
          },
        ],
      };
    }
  );

  // ── MIME TYPE LOOKUP ──

  server.tool(
    "util-get-content-type",
    "Look up the MIME content type for a given file name or extension",
    {
      fileName: z
        .string()
        .describe("File name or extension (e.g. 'report.pdf' or 'pdf')"),
    },
    async ({ fileName }) => {
      const contentType = determineContentType(fileName);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ fileName, contentType }),
          },
        ],
      };
    }
  );

  // ── CONTAINER NAME SANITISER ──

  server.tool(
    "util-to-container-name",
    "Convert arbitrary text (e.g. an email address, display name, URL) into a valid Azure Storage container name. " +
      "Rules enforced: 3-63 chars, lowercase alphanumeric + hyphens only, no leading/trailing/consecutive hyphens.",
    {
      input: z
        .string()
        .describe("The raw string to convert (e.g. 'Tom.Coppock@example.com')"),
      prefix: z
        .string()
        .optional()
        .describe("Optional prefix to prepend (e.g. 'user-' → 'user-tomcoppock')"),
      maxLength: z
        .number()
        .optional()
        .default(63)
        .describe("Max length of the result (3-63, default 63)"),
    },
    async ({ input, prefix, maxLength }) => {
      const name = toContainerName(input, prefix, maxLength);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ input, containerName: name }),
          },
        ],
      };
    }
  );
}

/**
 * MIME type lookup
 */
function determineContentType(filename: string): string {
  const extension =
    filename.split(/[/\\]/).pop()?.split(".").pop()?.toLowerCase() || filename.toLowerCase();
  const mimeTypes: Record<string, string> = {
    avi: "video/x-msvideo",
    bmp: "image/bmp",
    css: "text/css",
    csv: "text/csv",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    flv: "video/x-flv",
    gif: "image/gif",
    htm: "text/html",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "application/javascript",
    json: "application/json",
    m4v: "video/mp4",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    mp4: "video/mp4",
    ogv: "video/ogg",
    pdf: "application/pdf",
    png: "image/png",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    svg: "image/svg+xml",
    tif: "image/tiff",
    tiff: "image/tiff",
    txt: "text/plain",
    webm: "video/webm",
    wmv: "video/x-ms-wmv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xml: "application/xml",
    zip: "application/zip",
  };
  return mimeTypes[extension] || "application/octet-stream";
}

/**
 * Convert arbitrary text into a valid Azure Storage container name.
 *
 * Azure container name rules:
 *  - 3–63 characters
 *  - Lowercase letters, digits, and hyphens only
 *  - Must start and end with a letter or digit
 *  - No consecutive hyphens
 *
 * Strategy:
 *  1. Lowercase the input
 *  2. Replace @ and . and _ with hyphens (common in emails/domains)
 *  3. Strip all remaining non-alphanumeric/non-hyphen characters
 *  4. Collapse consecutive hyphens to a single hyphen
 *  5. Trim leading/trailing hyphens
 *  6. Truncate to maxLength
 *  7. Re-trim trailing hyphens after truncation
 *  8. If result < 3 chars, pad with trailing zeros
 */
function toContainerName(
  input: string,
  prefix?: string,
  maxLength = 63
): string {
  const cap = Math.min(Math.max(maxLength, 3), 63);

  let name = (prefix ?? "") + input;

  // 1. Lowercase
  name = name.toLowerCase();

  // 2. Replace common separators with hyphens
  name = name.replace(/[@._]/g, "-");

  // 3. Strip invalid characters
  name = name.replace(/[^a-z0-9-]/g, "");

  // 4. Collapse consecutive hyphens
  name = name.replace(/-{2,}/g, "-");

  // 5. Trim leading/trailing hyphens
  name = name.replace(/^-+|-+$/g, "");

  // 6. Truncate
  name = name.slice(0, cap);

  // 7. Re-trim trailing hyphens after truncation
  name = name.replace(/-+$/, "");

  // 8. Pad if too short
  while (name.length < 3) {
    name += "0";
  }

  return name;
}
