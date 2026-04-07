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
    "Encode a text string to base64. Use this BEFORE 'blob-create' or 'fileshare-upload-file' to convert text content (HTML, JSON, CSV, plain text, etc.) into the required base64 format. Returns JSON with 'base64' (the encoded string), 'originalLength', and 'base64Length'.",
    {
      text: z.string().describe("The text content to encode (e.g. an HTML document, JSON payload, or CSV data)"),
      encoding: z
        .enum(["utf-8", "ascii", "latin1"])
        .optional()
        .default("utf-8")
        .describe("Character encoding of the source text (default: 'utf-8')"),
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
    "Decode a base64 string back to readable text. Use this AFTER 'blob-read' or 'fileshare-read-file' to convert the returned 'contentBase64' field into human-readable text (HTML, JSON, CSV, etc.). Not suitable for binary files (images, PDFs). Returns JSON with 'text' (the decoded content), 'base64Length', and 'decodedLength'.",
    {
      base64: z.string().describe("The base64-encoded string to decode (e.g. the 'contentBase64' value from 'blob-read')"),
      encoding: z
        .enum(["utf-8", "ascii", "latin1"])
        .optional()
        .default("utf-8")
        .describe("Target character encoding for the decoded text (default: 'utf-8')"),
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
    "Generate a fresh SAS (Shared Access Signature) URL for a specific blob. Use this to replace an expired SAS URL, or as a standalone alternative to 'blob-get-sas-url'. Returns JSON with 'url' (the full SAS URL), 'sasToken', 'expiresOn' (ISO 8601), and 'permissions'.",
    {
      containerName: z.string().describe("Name of the container holding the blob (e.g. 'my-data-2024')"),
      blobName: z.string().describe("Full blob name including virtual directory path (e.g. 'reports/2024/q1-summary.pdf')"),
      expiryHours: z
        .number()
        .optional()
        .default(24)
        .describe("Hours until the new SAS token expires (default: 24)"),
      permissions: z
        .string()
        .optional()
        .default("r")
        .describe("SAS permissions string — combine: r=read, w=write, d=delete, l=list (default: 'r')"),
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
    "Generate a fresh SAS token scoped to an entire container. Use this to replace an expired container SAS, or as a standalone alternative to 'blob-get-container-sas'. Returns JSON with 'containerName', 'sasToken', 'connectionString' (ready-to-use for Azure SDK clients), 'expiresOn' (ISO 8601), and 'permissions'.",
    {
      containerName: z.string().describe("Name of the container to generate the SAS for (e.g. 'my-data-2024')"),
      expiryHours: z
        .number()
        .optional()
        .default(24)
        .describe("Hours until the new SAS token expires (default: 24)"),
      permissions: z
        .string()
        .optional()
        .default("rl")
        .describe("SAS permissions string — combine: r=read, l=list, w=write, d=delete (default: 'rl')"),
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
    "Look up the MIME content type for a file name or extension. Use this to determine the correct Content-Type header before uploading, or to identify a downloaded file's format. Returns JSON with 'fileName' and 'contentType'. Returns 'application/octet-stream' for unrecognised extensions.",
    {
      fileName: z
        .string()
        .describe("File name (e.g. 'report.pdf') or bare extension (e.g. 'pdf') to look up"),
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
    "Convert arbitrary text into a valid Azure Storage container name. Use this BEFORE 'blob-container-create' when the container name comes from user input, email addresses, URLs, or other free-form text. " +
      "Applies Azure naming rules: 3-63 chars, lowercase alphanumeric + hyphens only, no leading/trailing/consecutive hyphens. " +
      "Common characters like @, ., and _ are replaced with hyphens. Returns JSON with 'input' and the sanitised 'containerName'.",
    {
      input: z
        .string()
        .describe("The raw string to convert (e.g. 'Tom.Coppock@example.com', 'My Project 2024!', 'https://example.com/path')"),
      prefix: z
        .string()
        .optional()
        .describe("Optional prefix to prepend to the result (e.g. 'user-' → 'user-tom-coppock-example-com')"),
      maxLength: z
        .number()
        .optional()
        .default(63)
        .describe("Maximum length of the resulting name (3-63, default: 63)"),
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
