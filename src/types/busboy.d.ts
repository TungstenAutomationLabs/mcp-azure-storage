/**
 * Minimal type declarations for busboy v1.6.x.
 *
 * busboy is used exclusively in the /upload streaming pipeline (server.ts).
 * These declarations cover only the subset of the API we use.
 *
 * If @types/busboy is installed as a devDependency, this file can be removed.
 */

declare module "busboy" {
  import { Writable, Readable } from "stream";

  interface BusboyConfig {
    /** The request headers (must include content-type with multipart boundary). */
    headers: Record<string, string | string[] | undefined>;
    /** Limits on the incoming data. */
    limits?: {
      /** Max file size in bytes. */
      fileSize?: number;
      /** Max number of file fields. */
      files?: number;
      /** Max number of non-file fields. */
      fields?: number;
      /** Max number of parts (files + fields). */
      parts?: number;
      /** Max field name size in bytes. */
      fieldNameSize?: number;
      /** Max field value size in bytes. */
      fieldSize?: number;
    };
    /** Preserve the full path of the uploaded file name (default: false). */
    preservePath?: boolean;
  }

  interface FileInfo {
    /** The original filename from the client. */
    filename: string;
    /** The transfer encoding (e.g. "7bit", "binary"). */
    encoding: string;
    /** The MIME type (e.g. "application/pdf"). */
    mimeType: string;
  }

  interface FieldInfo {
    /** The transfer encoding. */
    encoding: string;
    /** The MIME type. */
    mimeType: string;
    /** Whether the field name was truncated. */
    nameTruncated: boolean;
    /** Whether the field value was truncated. */
    valueTruncated: boolean;
  }

  interface Busboy extends Writable {
    on(event: "file", listener: (name: string, stream: Readable, info: FileInfo) => void): this;
    on(event: "field", listener: (name: string, value: string, info: FieldInfo) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "finish", listener: () => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  function busboy(config: BusboyConfig): Busboy;
  export = busboy;
}
