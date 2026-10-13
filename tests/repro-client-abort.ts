/**
 * Reproduction script for client-abort crash vectors in POST /upload.
 *
 * This script creates a minimal Express app with the EXACT upload handler
 * code from server.ts (WITH the fix applied), mocks the Azure SDK to simulate
 * a slow upload, then aborts the request mid-stream. It listens for
 * unhandledRejection and uncaughtException to prove the fix works.
 *
 * Run with: npx tsx tests/repro-client-abort.ts
 */

import express, { Request, Response, NextFunction } from "express";
import Busboy from "busboy";
import { PassThrough } from "stream";
import http from "http";
import { Readable } from "stream";

// ── Track crashes ────────────────────────────────────────────────────────────
let unhandledRejections: Error[] = [];
let uncaughtExceptions: Error[] = [];

process.on("unhandledRejection", (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  unhandledRejections.push(err);
  console.error("[UNHANDLED REJECTION]", err.message);
});

process.on("uncaughtException", (err: Error) => {
  uncaughtExceptions.push(err);
  console.error("[UNCAUGHT EXCEPTION]", err.message);
  // Don't exit -- we want to observe all errors
});

// ── Mock Azure uploadStream that takes a long time ───────────────────────────
function mockSlowUploadStream(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    // Simulate Azure SDK reading from the stream
    stream.on("data", () => {
      // consuming data...
    });
    stream.on("error", (err) => {
      reject(err);
    });
    stream.on("end", () => {
      // Simulate commit delay
      setTimeout(resolve, 500);
    });
  });
}

// ── Build the Express app with the FIXED upload handler ─────────────────────
function buildApp() {
  const app = express();

  const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

  app.post("/upload", (req: Request, res: Response) => {
    const ct = req.headers["content-type"] || "";
    if (!ct.includes("multipart/form-data")) {
      res.status(400).json({ error: "Expected Content-Type: multipart/form-data" });
      return;
    }

    const fields: Record<string, string> = {};
    let fileReceived = false;
    let fileName = "";
    let mimeType = "application/octet-stream";
    let bytesReceived = 0;
    let limitExceeded = false;
    let responded = false;
    let uploadPromise: Promise<void> | null = null;
    let filePassThrough: PassThrough | null = null;
    let uploadError: Error | null = null; // FIX: captured upload rejection

    const bb = Busboy({
      headers: req.headers as Record<string, string>,
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
      },
    });

    bb.on("field", (name: string, value: string) => {
      fields[name] = value;
    });

    bb.on("file", (name: string, stream: any, info: any) => {
      if (name !== "file") {
        stream.resume();
        return;
      }

      fileReceived = true;
      fileName = info.filename;
      mimeType = info.mimeType || "application/octet-stream";

      if (!fields.containerName) {
        stream.resume();
        if (!res.headersSent) {
          responded = true;
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "invalid_field_order",
            message: "containerName and blobName fields must appear before the file part",
          }));
        }
        return;
      }

      filePassThrough = new PassThrough();
      filePassThrough.on("error", (err) => {
        console.log(`  [filePassThrough error handler] ${err.message}`);
      });

      stream.on("data", (chunk: Buffer) => {
        bytesReceived += chunk.length;
      });

      // FIX: error handler on busboy file sub-stream
      stream.on("error", (err: Error) => {
        console.log(`  [busboy file stream error] ${err.message}`);
        if (filePassThrough && !filePassThrough.destroyed) {
          filePassThrough.destroy(err);
        }
      });

      stream.pipe(filePassThrough);

      // FIX: .catch() absorbs rejection, stores in uploadError
      uploadPromise = (async () => {
        const containerName = fields.containerName;
        const blobName = fields.blobName || fileName;
        if (!containerName) return;

        await mockSlowUploadStream(filePassThrough!);
      })().catch((err: unknown) => {
        uploadError = err instanceof Error ? err : new Error(String(err));
        const msg = uploadError.message;
        if (msg !== "client_aborted" && msg !== "too_large" && msg !== "missing_field") {
          console.log(`  [uploadPromise catch - unexpected] ${msg}`);
        } else {
          console.log(`  [uploadPromise catch - expected] ${msg}`);
        }
        // Do NOT re-throw — the promise must resolve so it is never unhandled.
      });
    });

    bb.on("close", async () => {
      if (responded) return;

      if (limitExceeded) {
        responded = true;
        if (!res.headersSent) {
          res.status(413).json({ code: "too_large", error: "File too large" });
        }
        return;
      }

      if (!fileReceived) {
        responded = true;
        res.status(400).json({ error: "No file provided" });
        return;
      }

      const containerName = fields.containerName;
      if (!containerName) {
        responded = true;
        filePassThrough?.destroy(new Error("missing_field"));
        res.status(400).json({ error: "Missing required field: containerName" });
        return;
      }

      const blobName = fields.blobName || fileName;

      try {
        if (uploadPromise) {
          await uploadPromise;
          // FIX: check captured upload error
          if (uploadError) {
            throw uploadError;
          }
        }
        responded = true;
        res.status(200).json({ success: true, blobName, containerName, size: bytesReceived });
      } catch (error: unknown) {
        if (responded) return;
        responded = true;
        const message = error instanceof Error ? error.message : "Upload failed";

        // FIX: skip responding for client_aborted (dead connection)
        if (message === "client_aborted") {
          console.log("  [bb.close catch] client_aborted (no response needed)");
          return;
        }

        console.log(`  [bb.close catch] ${message}`);
        if (!res.headersSent) {
          res.status(500).json({ error: message });
        }
      }
    });

    bb.on("error", (err: Error) => {
      if (responded) return;
      responded = true;
      filePassThrough?.destroy(err);
      console.log(`  [bb.error] ${err.message}`);
      if (!res.headersSent) {
        res.status(400).json({ error: `Multipart parse error: ${err.message}` });
      }
    });

    // FIX: error handler on req stream
    req.on("error", (err: Error) => {
      console.log(`  [req.error] ${err.message}`);
      if (filePassThrough && !filePassThrough.destroyed) {
        filePassThrough.destroy(new Error("client_aborted"));
      }
    });

    // FIX: enhanced close handler with bb.destroy()
    req.on("close", () => {
      if (!req.complete && !res.writableFinished) {
        console.log("  [req.close] Client disconnected (req.complete=false)");
        if (filePassThrough && !filePassThrough.destroyed) {
          filePassThrough.destroy(new Error("client_aborted"));
        }
        bb.destroy();
      }
    });

    req.pipe(bb);
  });

  return app;
}

// ── Test runner ──────────────────────────────────────────────────────────────
async function runTest(testName: string, testFn: (port: number) => Promise<void>): Promise<boolean> {
  unhandledRejections = [];
  uncaughtExceptions = [];

  const app = buildApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, resolve);
  });

  const addr = server.address() as { port: number };
  const port = addr.port;

  console.log(`\n=== ${testName} (port ${port}) ===`);

  try {
    await testFn(port);
  } catch (err: any) {
    console.log(`  [test error] ${err.message}`);
  }

  // Wait for async events to propagate
  await new Promise((r) => setTimeout(r, 2000));

  server.close();

  const crashed = unhandledRejections.length > 0 || uncaughtExceptions.length > 0;
  if (crashed) {
    console.log(`  RESULT: CRASH DETECTED`);
    console.log(`    Unhandled rejections: ${unhandledRejections.length}`);
    for (const e of unhandledRejections) console.log(`      - ${e.message}`);
    console.log(`    Uncaught exceptions: ${uncaughtExceptions.length}`);
    for (const e of uncaughtExceptions) console.log(`      - ${e.message}`);
  } else {
    console.log(`  RESULT: NO CRASH (server survived)`);
  }

  return crashed;
}

// ── Helper: send a multipart upload and abort mid-stream ─────────────────────
function sendMultipartAndAbort(port: number, abortAfterBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const boundary = "----TestBoundary" + Math.random().toString(36).slice(2);

    const prelude =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="containerName"\r\n\r\ntest-container\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="blobName"\r\n\r\ntest-blob.bin\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="test-blob.bin"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;

    const epilogue = `\r\n--${boundary}--\r\n`;

    const fileSize = 10 * 1024 * 1024; // 10 MB "planned"
    const totalLength = Buffer.byteLength(prelude) + fileSize + Buffer.byteLength(epilogue);

    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path: "/upload",
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": totalLength,
      },
    };

    const req = http.request(options, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });

    req.on("error", (err) => {
      console.log(`  [client req.error] ${err.message}`);
      resolve();
    });

    req.write(prelude);

    let bytesSent = 0;
    const chunkSize = 16 * 1024; // 16 KB chunks
    const chunk = Buffer.alloc(chunkSize, 0x42);

    const sendInterval = setInterval(() => {
      if (bytesSent >= abortAfterBytes) {
        clearInterval(sendInterval);
        console.log(`  [client] Aborting after ${bytesSent} bytes`);
        req.destroy();
        setTimeout(resolve, 500);
        return;
      }
      try {
        req.write(chunk);
        bytesSent += chunkSize;
      } catch {
        clearInterval(sendInterval);
        resolve();
      }
    }, 10);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Client Abort Crash Reproduction (WITH FIX)");
  console.log("==========================================");

  const crashed1 = await runTest(
    "Test 1: Client abort mid-upload (uploadPromise absorbed)",
    async (port) => {
      await sendMultipartAndAbort(port, 128 * 1024);
    }
  );

  const crashed2 = await runTest(
    "Test 2: Very fast abort (before file data arrives)",
    async (port) => {
      await sendMultipartAndAbort(port, 1024);
    }
  );

  console.log("\n==========================================");
  console.log("SUMMARY:");
  console.log(`  Test 1 (mid-upload abort): ${crashed1 ? "CRASH" : "OK"}`);
  console.log(`  Test 2 (fast abort):       ${crashed2 ? "CRASH" : "OK"}`);
  console.log("==========================================");

  if (crashed1 || crashed2) {
    console.log("\nFAILED: Fix did NOT prevent crash.");
    process.exit(1);
  } else {
    console.log("\nPASSED: Server survived client aborts gracefully.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
