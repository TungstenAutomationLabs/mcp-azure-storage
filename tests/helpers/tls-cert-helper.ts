/**
 * Test helper: generate self-signed TLS certificates using openssl CLI.
 *
 * Certificates are generated in a temporary directory and cleaned up
 * after tests. If openssl is not available on the system, tests that
 * depend on this helper should be skipped with a clear reason.
 *
 * **Never commits private keys or certificates -- everything is
 * generated in beforeAll/beforeEach and cleaned up in afterAll/afterEach.**
 *
 * @module tests/helpers/tls-cert-helper
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Result of generating a self-signed certificate pair. */
export interface TestCertificate {
  certPath: string;
  keyPath: string;
  certPem: string;
  keyPem: string;
  /** Temporary directory containing the files (for cleanup). */
  tmpDir: string;
}

// ---------------------------------------------------------------------------
// OpenSSL binary discovery
// ---------------------------------------------------------------------------

/** Cached openssl path (empty string = not found). */
let _opensslPath: string | null = null;

/**
 * Find the openssl binary, checking PATH first then common Windows locations.
 *
 * @returns The openssl command string, or null if not found.
 */
function findOpenssl(): string | null {
  if (_opensslPath !== null) return _opensslPath || null;

  // Try PATH first
  try {
    execSync("openssl version", { stdio: "pipe" });
    _opensslPath = "openssl";
    return _opensslPath;
  } catch {
    // Not on PATH
  }

  // Windows: check Git for Windows bundled openssl
  const gitOpensslPaths = [
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe",
  ];
  for (const p of gitOpensslPaths) {
    if (existsSync(p)) {
      try {
        execSync(`"${p}" version`, { stdio: "pipe" });
        _opensslPath = `"${p}"`;
        return _opensslPath;
      } catch {
        // Binary exists but doesn't work
      }
    }
  }

  _opensslPath = "";
  return null;
}

/**
 * Check whether openssl CLI is available on this system.
 *
 * @returns true if openssl can be found and executed.
 */
export function isOpensslAvailable(): boolean {
  return findOpenssl() !== null;
}

/**
 * Get the openssl command string. Throws if not available.
 */
function ssl(): string {
  const cmd = findOpenssl();
  if (!cmd) throw new Error("openssl is not available on this system");
  return cmd;
}

// ---------------------------------------------------------------------------
// Certificate generation
// ---------------------------------------------------------------------------

/**
 * Generate a self-signed EC P-256 certificate + key pair using openssl.
 *
 * The certificate is valid for the specified number of days (default 365).
 * Files are written to a fresh temporary directory.
 *
 * @param options - Optional configuration.
 * @param options.days - Certificate validity in days (default 365).
 * @param options.cn - Common Name for the certificate (default "localhost").
 * @param options.expired - If true, generate an already-expired certificate.
 * @param options.notYetValid - If true, generate a not-yet-valid certificate.
 * @returns Paths and PEM content for the generated pair.
 */
export function generateTestCertificate(options?: {
  days?: number;
  cn?: string;
  expired?: boolean;
  notYetValid?: boolean;
}): TestCertificate {
  const { days = 365, cn = "localhost", expired = false, notYetValid = false } = options ?? {};
  const openssl = ssl();

  const tmpDir = mkdtempSync(join(tmpdir(), "mcp-tls-test-"));
  const keyPath = join(tmpDir, "key.pem");
  const certPath = join(tmpDir, "cert.pem");

  // Generate EC P-256 private key
  execSync(`${openssl} ecparam -genkey -name prime256v1 -noout -out "${keyPath}"`, {
    stdio: "pipe",
  });

  if (expired) {
    // Generate an already-expired certificate using OpenSSL 3.4+ -not_before/-not_after
    const csrPath = join(tmpDir, "csr.pem");
    execSync(
      `${openssl} req -new -key "${keyPath}" -out "${csrPath}" -subj "/CN=${cn}"`,
      { stdio: "pipe" }
    );

    // First try OpenSSL 3.4+ syntax with -not_before and -not_after
    try {
      execSync(
        `${openssl} x509 -req -in "${csrPath}" -signkey "${keyPath}" -out "${certPath}" ` +
        `-set_serial 2 -not_before 20200101000000Z -not_after 20200102000000Z`,
        { stdio: "pipe" }
      );
    } catch {
      // Fallback for older OpenSSL: use -startdate/-enddate
      try {
        execSync(
          `${openssl} x509 -req -in "${csrPath}" -signkey "${keyPath}" -out "${certPath}" ` +
          `-set_serial 3 -startdate 200101000000Z -enddate 200102000000Z`,
          { stdio: "pipe" }
        );
      } catch {
        // Last resort: 0-day cert (may appear valid briefly)
        execSync(
          `${openssl} x509 -req -in "${csrPath}" -signkey "${keyPath}" -out "${certPath}" ` +
          `-days 0 -set_serial 1`,
          { stdio: "pipe" }
        );
      }
    }
  } else if (notYetValid) {
    // Generate a certificate that's not yet valid (starts in the future)
    const csrPath = join(tmpDir, "csr.pem");
    execSync(
      `${openssl} req -new -key "${keyPath}" -out "${csrPath}" -subj "/CN=${cn}"`,
      { stdio: "pipe" }
    );
    try {
      execSync(
        `${openssl} x509 -req -in "${csrPath}" -signkey "${keyPath}" -out "${certPath}" ` +
        `-set_serial 4 -not_before 20400101000000Z -not_after 20410101000000Z`,
        { stdio: "pipe" }
      );
    } catch {
      try {
        execSync(
          `${openssl} x509 -req -in "${csrPath}" -signkey "${keyPath}" -out "${certPath}" ` +
          `-set_serial 5 -startdate 400101000000Z -enddate 410101000000Z`,
          { stdio: "pipe" }
        );
      } catch {
        // Fall back to a normal cert -- tests should detect this limitation
        execSync(
          `${openssl} req -new -x509 -key "${keyPath}" -out "${certPath}" ` +
          `-days ${days} -subj "/CN=${cn}"`,
          { stdio: "pipe" }
        );
      }
    }
  } else {
    // Generate a normal self-signed certificate
    execSync(
      `${openssl} req -new -x509 -key "${keyPath}" -out "${certPath}" ` +
      `-days ${days} -subj "/CN=${cn}" -addext "subjectAltName=DNS:${cn},IP:127.0.0.1"`,
      { stdio: "pipe" }
    );
  }

  const certPem = readFileSync(certPath, "utf-8");
  const keyPem = readFileSync(keyPath, "utf-8");

  return { certPath, keyPath, certPem, keyPem, tmpDir };
}

/**
 * Generate a second key pair (for mismatched cert/key testing).
 *
 * Returns a key that does NOT match the certificate from another pair.
 *
 * @returns Path to the mismatched key file and the PEM content.
 */
export function generateMismatchedKey(tmpDir: string): { keyPath: string; keyPem: string } {
  const openssl = ssl();
  const keyPath = join(tmpDir, "mismatched-key.pem");
  execSync(`${openssl} ecparam -genkey -name prime256v1 -noout -out "${keyPath}"`, {
    stdio: "pipe",
  });
  const keyPem = readFileSync(keyPath, "utf-8");
  return { keyPath, keyPem };
}

/**
 * Clean up a temporary directory created by generateTestCertificate.
 *
 * @param tmpDir - The temporary directory to remove.
 */
export function cleanupTestCertificate(tmpDir: string): void {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors (Windows file locking, etc.)
  }
}
