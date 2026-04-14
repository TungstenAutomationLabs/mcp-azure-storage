/**
 * Utility MCP tools — 7 tools.
 *
 * Provides helper operations that support the primary storage tools:
 *  - Base64 encoding/decoding — required for text↔base64 conversion when
 *    uploading or downloading text files via blob/fileshare tools.
 *  - SAS token refresh — generates fresh SAS URLs/tokens for blobs and containers.
 *  - MIME type lookup — identifies content types from file extensions.
 *  - Container name sanitisation — converts free-form text into valid
 *    Azure Storage container names.
 *  - Upload info — returns the direct file upload endpoint URL and instructions
 *    (advertises the /upload REST endpoint to MCP clients).
 *
 * @module tools/utility-tools
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatSchema, formatResponse } from "../utils/format.js";
import {
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  ContainerSASPermissions,
  SASProtocol,
} from "@azure/storage-blob";
import { getStorageConfig } from "../config.js";

/**
 * Register all 7 utility tools on the given MCP server.
 *
 * These tools are stateless helpers — they don't maintain any persistent
 * client connections (SAS generation uses short-lived credential objects).
 */
export function registerUtilityTools(server: McpServer): void {
  const config = getStorageConfig();

  // ── BASE64 CONVERSION ────────────────────────────────────────────────────
  // These tools bridge the gap between human-readable text and the base64
  // format required by blob-create, blob-read, fileshare-upload, etc.

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
      format: formatSchema,
    },
    async ({ text, encoding, format }) => {
      const base64 = Buffer.from(text, encoding as BufferEncoding).toString(
        "base64"
      );
      return formatResponse({
        base64,
        originalLength: text.length,
        base64Length: base64.length,
      }, format, "Base64 Encoded");
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
      format: formatSchema,
    },
    async ({ base64, encoding, format }) => {
      const decoded = Buffer.from(base64, "base64").toString(
        encoding as BufferEncoding
      );
      return formatResponse({
        text: decoded,
        base64Length: base64.length,
        decodedLength: decoded.length,
      }, format, "Base64 Decoded");
    }
  );

  // ── SAS TOKEN REFRESH ────────────────────────────────────────────────────
  // Generate fresh SAS URLs/tokens to replace expired ones. These are
  // standalone alternatives to the SAS tools in blob-tools.ts.

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
      format: formatSchema,
    },
    async ({ containerName, blobName, expiryHours, permissions, format }) => {
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

      return formatResponse({
        url,
        sasToken,
        expiresOn: expiresOn.toISOString(),
        permissions,
      }, format, "Blob SAS Refreshed");
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
      format: formatSchema,
    },
    async ({ containerName, expiryHours, permissions, format }) => {
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

      return formatResponse({
        containerName,
        sasToken,
        connectionString,
        expiresOn: expiresOn.toISOString(),
        permissions,
      }, format, "Container SAS Refreshed");
    }
  );

  // ── MIME TYPE LOOKUP ─────────────────────────────────────────────────────

  server.tool(
    "util-get-content-type",
    "Look up the MIME content type for a file name or extension. Use this to determine the correct Content-Type header before uploading, or to identify a downloaded file's format. Returns JSON with 'fileName' and 'contentType'. Returns 'application/octet-stream' for unrecognised extensions.",
    {
      fileName: z
        .string()
        .describe("File name (e.g. 'report.pdf') or bare extension (e.g. 'pdf') to look up"),
      format: formatSchema,
    },
    async ({ fileName, format }) => {
      const contentType = determineContentType(fileName);
      return formatResponse({ fileName, contentType }, format, "Content Type");
    }
  );

  // ── CONTAINER NAME SANITISER ─────────────────────────────────────────────
  // Converts arbitrary text (emails, URLs, display names) into names that
  // satisfy Azure's strict container naming rules.

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
      format: formatSchema,
    },
    async ({ input, prefix, maxLength, format }) => {
      const name = toContainerName(input, prefix, maxLength);
      return formatResponse({ input, containerName: name }, format, "Container Name");
    }
  );

  // ── UPLOAD INFO ───────────────────────────────────────────────────────────
  // Advertises the /upload REST endpoint to MCP clients. Without this tool,
  // the /upload endpoint is invisible through the MCP tools/list mechanism.

  server.tool(
    "util-get-upload-url",
    "Get the direct file upload endpoint URL and usage instructions. " +
      "The MCP server provides a REST endpoint (POST /upload) that accepts standard multipart form-data uploads — " +
      "bypassing JSON-RPC entirely. Use this for large or binary files (PDFs, images, videos) that cannot be " +
      "practically base64-encoded in an MCP tool call. " +
      "Returns the upload URL, required fields, size limits, and example curl/Python commands. " +
      "The same API key used for MCP requests authenticates upload requests.",
    {
      format: formatSchema,
    },
    async ({ format }) => {
      // Derive the upload URL from the server's own origin.
      // In production (Azure Container Apps), the HOST header provides the FQDN.
      // Locally, fall back to localhost.
      const port = process.env.PORT || "3000";
      const baseUrl = process.env.WEBSITE_HOSTNAME
        ? `https://${process.env.WEBSITE_HOSTNAME}`
        : `http://localhost:${port}`;

      return formatResponse(
        {
          uploadUrl: `${baseUrl}/upload`,
          method: "POST",
          contentType: "multipart/form-data",
          authentication: "X-API-Key header (same key as MCP requests)",
          maxFileSize: "100 MB",
          fields: {
            file: "(required) The file to upload — multipart form field",
            containerName: "(required) Target blob container name",
            blobName: "(optional) Blob name with path — defaults to the uploaded filename",
            metadata: '(optional) JSON string of key-value metadata, e.g. {"author":"Alice"}',
          },
          examples: {
            curl: `curl -X POST ${baseUrl}/upload -H "X-API-Key: <key>" -F "file=@./report.pdf" -F "containerName=documents" -F "blobName=reports/report.pdf"`,
            python: `requests.post("${baseUrl}/upload", headers={"X-API-Key": "<key>"}, files={"file": open("report.pdf", "rb")}, data={"containerName": "documents", "blobName": "reports/report.pdf"})`,
          },
          notes: [
            "This endpoint is NOT part of the MCP JSON-RPC protocol — it is a standard REST endpoint.",
            "Use 'blob-upload-from-url' if the file is already accessible via a public URL.",
            "Use 'blob-create' with base64 content for small text files only.",
            "For files larger than 100 MB, use 'blob-get-container-sas' to get a write SAS URL and upload directly to Azure.",
          ],
        },
        format,
        "File Upload Endpoint"
      );
    }
  );
}

/**
 * Determine the MIME content type from a filename or bare extension.
 *
 * Extracts the extension from the last path segment, looks it up in a
 * static map of common types, and falls back to "application/octet-stream".
 *
 * @param filename - File name, path, or bare extension (e.g. "pdf").
 * @returns The MIME type string.
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
