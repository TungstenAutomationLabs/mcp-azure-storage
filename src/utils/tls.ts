/**
 * TLS support for mcp-azure-storage.
 *
 * Provides native HTTPS serving when TLS_CERT_FILE and TLS_KEY_FILE are set.
 * When neither is set, the server falls back to plain HTTP (backwards compatible).
 *
 * Features:
 *  - Certificate/key validation at startup (match check, date validity)
 *  - Hot reload of certificates without server restart (directory watching)
 *  - Debounced file-change events (handles renewal tools that write files separately)
 *
 * @module utils/tls
 */

import { readFileSync, watch as fsWatch } from "node:fs";
import { dirname } from "node:path";
import { X509Certificate, createPrivateKey } from "node:crypto";
import type { SecureContextOptions } from "node:tls";
import type { Server as HttpsServer } from "node:https";
import { info, warn, error as logError } from "./otel-logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed TLS configuration from environment variables. */
export interface TlsConfig {
  certPath: string;
  keyPath: string;
  minVersion: "TLSv1.2" | "TLSv1.3";
}

/** Result of loading and validating a certificate/key pair. */
export interface CertificateFiles {
  cert: Buffer;
  key: Buffer;
}

// ---------------------------------------------------------------------------
// Environment variable reading
// ---------------------------------------------------------------------------

/**
 * Read TLS-related environment variables and validate them.
 *
 * - When both TLS_CERT_FILE and TLS_KEY_FILE are set, returns a TlsConfig.
 * - When neither is set, returns null (plain HTTP mode).
 * - When only one is set, throws with a clear error message.
 *
 * @returns TlsConfig or null for plain HTTP mode.
 * @throws {Error} If only one of TLS_CERT_FILE / TLS_KEY_FILE is set,
 *   or if TLS_MIN_VERSION has an invalid value.
 */
export function getTlsConfig(): TlsConfig | null {
  const certPath = process.env.TLS_CERT_FILE;
  const keyPath = process.env.TLS_KEY_FILE;

  const hasCert = Boolean(certPath);
  const hasKey = Boolean(keyPath);

  // Neither set -- plain HTTP mode
  if (!hasCert && !hasKey) {
    return null;
  }

  // One without the other -- refuse to start
  if (hasCert && !hasKey) {
    throw new Error(
      "TLS_CERT_FILE is set but TLS_KEY_FILE is missing. " +
      "Both must be set for HTTPS, or neither for plain HTTP."
    );
  }
  if (!hasCert && hasKey) {
    throw new Error(
      "TLS_KEY_FILE is set but TLS_CERT_FILE is missing. " +
      "Both must be set for HTTPS, or neither for plain HTTP."
    );
  }

  // Validate TLS_MIN_VERSION
  const rawMinVersion = process.env.TLS_MIN_VERSION || "TLSv1.3";
  if (rawMinVersion !== "TLSv1.2" && rawMinVersion !== "TLSv1.3") {
    // The rejected value is not echoed: it is environment text, and startup
    // errors reach stderr and the container logs.
    throw new Error(
      'Invalid TLS_MIN_VERSION. Accepted values are "TLSv1.2" or "TLSv1.3".'
    );
  }

  return {
    certPath: certPath!,
    keyPath: keyPath!,
    // The allowlisted constant, not the environment string itself.
    minVersion: rawMinVersion === "TLSv1.2" ? "TLSv1.2" : "TLSv1.3",
  };
}

// ---------------------------------------------------------------------------
// Certificate file loading
// ---------------------------------------------------------------------------

/**
 * Read certificate and key files from disc.
 *
 * @param certPath - Path to the PEM certificate file.
 * @param keyPath  - Path to the PEM private key file.
 * @returns The raw file contents as Buffers.
 * @throws {Error} If either file cannot be read.
 */
export function loadCertificateFiles(certPath: string, keyPath: string): CertificateFiles {
  let cert: Buffer;
  let key: Buffer;

  try {
    cert = readFileSync(certPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read TLS certificate file "${certPath}": ${msg}`);
  }

  try {
    key = readFileSync(keyPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read TLS key file "${keyPath}": ${msg}`);
  }

  return { cert, key };
}

// ---------------------------------------------------------------------------
// Certificate validation
// ---------------------------------------------------------------------------

/**
 * Verify that a private key matches a certificate using X509Certificate.
 *
 * @param cert - PEM certificate content.
 * @param key  - PEM private key content.
 * @throws {Error} If the key does not match the certificate.
 */
export function validateCertificateMatch(cert: Buffer, key: Buffer): void {
  const x509 = new X509Certificate(cert);
  const privateKey = createPrivateKey(key);

  if (!x509.checkPrivateKey(privateKey)) {
    throw new Error(
      "TLS certificate and private key do not match. " +
      "Ensure TLS_CERT_FILE and TLS_KEY_FILE refer to a matching pair."
    );
  }
}

/**
 * Check that a certificate is currently valid (not expired, not not-yet-valid).
 *
 * @param cert - PEM certificate content.
 * @throws {Error} If the certificate is expired or not yet valid.
 */
export function validateCertificateValidity(cert: Buffer): void {
  const x509 = new X509Certificate(cert);
  const now = new Date();

  const validFrom = new Date(x509.validFrom);
  const validTo = new Date(x509.validTo);

  if (now < validFrom) {
    throw new Error(
      `TLS certificate is not yet valid. Valid from: ${x509.validFrom}. ` +
      `Current time: ${now.toISOString()}.`
    );
  }

  if (now > validTo) {
    throw new Error(
      `TLS certificate has expired. Valid to: ${x509.validTo}. ` +
      `Current time: ${now.toISOString()}.`
    );
  }
}

// ---------------------------------------------------------------------------
// TLS options builder
// ---------------------------------------------------------------------------

/**
 * Build tls.SecureContextOptions from certificate files and configuration.
 *
 * Reads, validates (match + validity), and returns options suitable for
 * https.createServer() or server.setSecureContext().
 *
 * @param certPath   - Path to the PEM certificate file.
 * @param keyPath    - Path to the PEM private key file.
 * @param minVersion - Minimum TLS version ("TLSv1.2" or "TLSv1.3").
 * @returns SecureContextOptions ready for Node.js HTTPS.
 * @throws {Error} If files cannot be read, or the pair is invalid.
 */
export function createTlsOptions(
  certPath: string,
  keyPath: string,
  minVersion: "TLSv1.2" | "TLSv1.3",
): SecureContextOptions {
  const { cert, key } = loadCertificateFiles(certPath, keyPath);
  validateCertificateMatch(cert, key);
  validateCertificateValidity(cert);

  return {
    cert,
    key,
    minVersion,
  };
}

// ---------------------------------------------------------------------------
// Certificate hot-reload (directory watching with debounce)
// ---------------------------------------------------------------------------

/** Handle returned by watchCertificates for cleanup. */
export interface CertificateWatcher {
  /** Stop watching for certificate changes. */
  close(): void;
}

/**
 * Watch certificate and key file directories for changes and hot-reload
 * the TLS context when valid new files are detected.
 *
 * Watches the **directory** (not the file) because renewal tools (certbot,
 * cert-manager) typically replace files via atomic rename, which would
 * cause a direct file watcher to stop receiving events.
 *
 * File-change events are debounced by 1 second to handle the case where
 * the cert and key are written at slightly different times.
 *
 * On successful reload, calls `server.setSecureContext()` to apply the
 * new certificate without dropping existing connections.
 *
 * On failure (mismatched pair, expired cert, unreadable files), the old
 * certificate is kept and a warning is logged. File contents and key
 * material are **never** logged.
 *
 * @param server   - The HTTPS server to update.
 * @param certPath - Path to the PEM certificate file.
 * @param keyPath  - Path to the PEM private key file.
 * @param minVersion - Minimum TLS version for the new context.
 * @returns A CertificateWatcher handle for cleanup.
 */
export function watchCertificates(
  server: HttpsServer,
  certPath: string,
  keyPath: string,
  minVersion: "TLSv1.2" | "TLSv1.3",
): CertificateWatcher {
  const DEBOUNCE_MS = 1000;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const reloadCertificates = (): void => {
    try {
      const { cert, key } = loadCertificateFiles(certPath, keyPath);
      validateCertificateMatch(cert, key);
      validateCertificateValidity(cert);

      server.setSecureContext({ cert, key, minVersion });

      // File locations come from TLS_CERT_FILE / TLS_KEY_FILE and are not
      // logged (stdout is shipped to Log Analytics).
      info("TLS certificates reloaded successfully", { component: "tls" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warn("TLS certificate reload failed; keeping existing certificate", {
        component: "tls",
        error: msg,
      });
    }
  };

  const onFileChange = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(reloadCertificates, DEBOUNCE_MS);
  };

  // Deduplicate directories -- cert and key may be in the same directory
  const certDir = dirname(certPath);
  const keyDir = dirname(keyPath);
  const dirsToWatch = new Set([certDir, keyDir]);

  const watchers: ReturnType<typeof fsWatch>[] = [];

  for (const dir of dirsToWatch) {
    try {
      const watcher = fsWatch(dir, { persistent: false }, (_event, _filename) => {
        onFileChange();
      });
      watchers.push(watcher);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warn("Failed to set up certificate file watcher", {
        component: "tls",
        directory: dir === certDir ? "TLS_CERT_FILE directory" : "TLS_KEY_FILE directory",
        error: msg,
      });
    }
  }

  if (watchers.length > 0) {
    info("Certificate file watcher active", {
      component: "tls",
      watchedDirectories: watchers.length,
    });
  }

  return {
    close() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      for (const w of watchers) {
        w.close();
      }
    },
  };
}
