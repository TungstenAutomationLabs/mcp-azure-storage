/**
 * Integration-style tests for TLS server functionality.
 *
 * Tests that the HTTPS server accepts connections, rejects plain HTTP,
 * and supports certificate hot-reload.
 *
 * Certificates are generated at test time using the openssl CLI.
 * Tests are skipped if openssl is not available.
 */

import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import { readFileSync, writeFileSync } from "node:fs";
import express from "express";
import {
  isOpensslAvailable,
  generateTestCertificate,
  generateMismatchedKey,
  cleanupTestCertificate,
  type TestCertificate,
} from "./helpers/tls-cert-helper.js";
import {
  createTlsOptions,
  watchCertificates,
  type CertificateWatcher,
} from "../src/utils/tls.js";

const HAS_OPENSSL = isOpensslAvailable();

/**
 * Make an HTTPS GET request with self-signed certificate support.
 *
 * @returns The response body as a string and the status code.
 */
function httpsGet(
  url: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { rejectUnauthorized: false },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            body,
          });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error("Request timed out"));
    });
  });
}

/**
 * Make a plain HTTP GET request.
 */
function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode || 0, body });
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error("Request timed out"));
    });
  });
}

/**
 * Get the TLS certificate fingerprint served by a host:port.
 */
function getCertificateFingerprint(
  host: string,
  port: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        const fingerprint = cert?.fingerprint256 || "";
        socket.end();
        resolve(fingerprint);
      },
    );
    socket.on("error", reject);
    socket.setTimeout(3000, () => {
      socket.destroy(new Error("TLS handshake timed out"));
    });
  });
}

/**
 * Wait for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a test Express app with a /health endpoint.
 */
function createTestApp(): ReturnType<typeof express> {
  const app = express();
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "healthy" });
  });
  return app;
}

/**
 * Start an HTTPS server on a random port and return the server + port.
 */
async function startTestHttpsServer(
  certPath: string,
  keyPath: string,
): Promise<{ server: https.Server; port: number }> {
  const app = createTestApp();
  const tlsOptions = createTlsOptions(certPath, keyPath, "TLSv1.3");
  const server = https.createServer(tlsOptions, app);

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  return { server, port };
}

/**
 * Close a server and wait for it to finish.
 */
function closeServer(server: https.Server | http.Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// HTTPS server tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_OPENSSL)("TLS server integration", () => {
  let testCert: TestCertificate;
  let server: https.Server | null = null;

  beforeAll(() => {
    testCert = generateTestCertificate({ cn: "localhost" });
  });

  afterAll(() => {
    cleanupTestCertificate(testCert.tmpDir);
  });

  afterEach(async () => {
    await closeServer(server);
    server = null;
  });

  it("accepts HTTPS connections with the test certificate", async () => {
    const result = await startTestHttpsServer(testCert.certPath, testCert.keyPath);
    server = result.server;

    const response = await httpsGet(`https://127.0.0.1:${result.port}/health`);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("healthy");
  }, 10_000);

  it("rejects plain HTTP connections on the TLS port", async () => {
    const result = await startTestHttpsServer(testCert.certPath, testCert.keyPath);
    server = result.server;

    // Plain HTTP to an HTTPS port should fail
    await expect(httpGet(`http://127.0.0.1:${result.port}/health`)).rejects.toThrow();
  }, 10_000);

  it("applies minimum TLS version (TLSv1.3)", async () => {
    const app = createTestApp();
    const tlsOptions = createTlsOptions(testCert.certPath, testCert.keyPath, "TLSv1.3");
    server = https.createServer(tlsOptions, app);

    const port = await new Promise<number>((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    // A request with TLSv1.3 should succeed
    const response = await httpsGet(`https://127.0.0.1:${port}/health`);
    expect(response.statusCode).toBe(200);

    // Attempting to connect with maxVersion TLSv1.2 should fail when
    // server requires TLSv1.3
    const failPromise = new Promise<void>((resolve, reject) => {
      const socket = tls.connect(
        {
          host: "127.0.0.1",
          port,
          rejectUnauthorized: false,
          maxVersion: "TLSv1.2",
        },
        () => {
          socket.end();
          reject(new Error("Should have failed with TLSv1.2"));
        },
      );
      socket.on("error", () => {
        resolve(); // Expected: connection should fail
      });
      socket.setTimeout(3000, () => {
        socket.destroy();
        reject(new Error("TLS handshake timed out"));
      });
    });

    await expect(failPromise).resolves.toBeUndefined();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Certificate hot-reload tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_OPENSSL)("Certificate hot-reload", () => {
  let testCert: TestCertificate;
  let server: https.Server | null = null;
  let watcher: CertificateWatcher | null = null;

  beforeAll(() => {
    testCert = generateTestCertificate({ cn: "localhost" });
  });

  afterAll(() => {
    cleanupTestCertificate(testCert.tmpDir);
  });

  afterEach(async () => {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    await closeServer(server);
    server = null;
  });

  it("picks up new certificates without restart", async () => {
    // Suppress console output during this test
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await startTestHttpsServer(testCert.certPath, testCert.keyPath);
    server = result.server;

    // Get the initial certificate fingerprint
    const initialFingerprint = await getCertificateFingerprint("127.0.0.1", result.port);
    expect(initialFingerprint).toBeTruthy();

    // Set up the certificate watcher
    watcher = watchCertificates(server, testCert.certPath, testCert.keyPath, "TLSv1.3");

    // Generate a new certificate (same key is fine for this test)
    const newCert = generateTestCertificate({ cn: "localhost" });

    // Write the new cert and key to the watched paths
    writeFileSync(testCert.certPath, readFileSync(newCert.certPath));
    writeFileSync(testCert.keyPath, readFileSync(newCert.keyPath));

    // Wait for the debounced reload (1s debounce + buffer)
    await sleep(2500);

    // Verify the new certificate is being served
    const reloadedFingerprint = await getCertificateFingerprint("127.0.0.1", result.port);
    expect(reloadedFingerprint).toBeTruthy();

    // The fingerprint should have changed (new certificate)
    expect(reloadedFingerprint).not.toBe(initialFingerprint);

    // Clean up the temporary new cert directory
    cleanupTestCertificate(newCert.tmpDir);
    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  }, 15_000);

  it("keeps old certificate when renewal provides invalid pair", async () => {
    // Suppress console output during this test
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await startTestHttpsServer(testCert.certPath, testCert.keyPath);
    server = result.server;

    // Get initial fingerprint
    const initialFingerprint = await getCertificateFingerprint("127.0.0.1", result.port);
    expect(initialFingerprint).toBeTruthy();

    // Set up the certificate watcher
    watcher = watchCertificates(server, testCert.certPath, testCert.keyPath, "TLSv1.3");

    // Write a mismatched key (cert stays the same, key is different)
    const { keyPath: mismatchedKeyPath } = generateMismatchedKey(testCert.tmpDir);
    const mismatchedKeyContent = readFileSync(mismatchedKeyPath);

    // Save original key to restore later
    const originalKey = readFileSync(testCert.keyPath);

    writeFileSync(testCert.keyPath, mismatchedKeyContent);

    // Wait for the debounced reload attempt
    await sleep(2500);

    // The server should still be serving with the old certificate
    const afterFingerprint = await getCertificateFingerprint("127.0.0.1", result.port);
    expect(afterFingerprint).toBeTruthy();

    // Fingerprint should be the same (old certificate kept)
    expect(afterFingerprint).toBe(initialFingerprint);

    // Restore original key for cleanup
    writeFileSync(testCert.keyPath, originalKey);

    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  }, 15_000);
});
