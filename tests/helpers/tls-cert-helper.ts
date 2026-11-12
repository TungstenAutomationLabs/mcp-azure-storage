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
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
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

  if (expired || notYetValid) {
    // Dates are relative to now, so these fixtures never age into or out of
    // validity. Expired: ended a day ago. Not yet valid: starts in a year.
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const notBefore = expired ? new Date(now - 2 * DAY) : new Date(now + 365 * DAY);
    const notAfter = expired ? new Date(now - DAY) : new Date(now + 2 * 365 * DAY);
    generateDatedCertificate(openssl, tmpDir, keyPath, certPath, cn, notBefore, notAfter);
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

/** Format a date as an OpenSSL GeneralizedTime string (YYYYMMDDHHMMSSZ). */
function opensslTime(d: Date): string {
  return d.toISOString().replace(/[-:T]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Write a self-signed certificate with an exact validity window.
 *
 * Uses `openssl ca -selfsign -startdate -enddate`, which OpenSSL 1.1.1 and
 * every 3.x support. (`openssl x509 -not_before/-not_after` exists only from
 * OpenSSL 3.4, and `x509` has no `-startdate`; with an older openssl the
 * previous helper silently produced a currently valid certificate.)
 *
 * The leaf carries CA:FALSE, digitalSignature, serverAuth and a DNS SAN for
 * `cn`. Afterwards the dates are read back with Node's X509Certificate, and
 * anything other than the requested window throws, so a fixture can never
 * quietly be the wrong kind of certificate.
 */
function generateDatedCertificate(
  openssl: string,
  tmpDir: string,
  keyPath: string,
  certPath: string,
  cn: string,
  notBefore: Date,
  notAfter: Date,
): void {
  // Forward slashes: OpenSSL config treats backslash as an escape (Windows paths).
  const dir = tmpDir.replace(/\\/g, "/");
  const csrPath = join(tmpDir, "csr.pem");
  const configPath = join(tmpDir, "ca.cnf");
  writeFileSync(join(tmpDir, "index.txt"), "");
  writeFileSync(join(tmpDir, "serial"), "01\n");
  writeFileSync(configPath, [
    "[ ca ]",
    "default_ca = test_ca",
    "[ test_ca ]",
    `database = ${dir}/index.txt`,
    `new_certs_dir = ${dir}`,
    `serial = ${dir}/serial`,
    "default_md = sha256",
    "policy = policy_any",
    "unique_subject = no",
    "copy_extensions = none",
    "x509_extensions = leaf_ext",
    "[ policy_any ]",
    "commonName = supplied",
    "[ leaf_ext ]",
    "basicConstraints = critical, CA:FALSE",
    "keyUsage = critical, digitalSignature",
    "extendedKeyUsage = serverAuth",
    `subjectAltName = DNS:${cn}`,
    "",
  ].join("\n"));

  execSync(`${openssl} req -new -key "${keyPath}" -out "${csrPath}" -subj "/CN=${cn}"`, { stdio: "pipe" });
  execSync(
    `${openssl} ca -batch -notext -config "${configPath}" -selfsign -keyfile "${keyPath}" ` +
    `-in "${csrPath}" -out "${certPath}" -startdate ${opensslTime(notBefore)} -enddate ${opensslTime(notAfter)}`,
    { stdio: "pipe" },
  );

  const x509 = new X509Certificate(readFileSync(certPath));
  const from = new Date(x509.validFrom).getTime();
  const to = new Date(x509.validTo).getTime();
  // OpenSSL stores whole seconds; allow for the dropped milliseconds.
  if (Math.abs(from - notBefore.getTime()) > 1000 || Math.abs(to - notAfter.getTime()) > 1000) {
    throw new Error(
      `Test certificate has the wrong validity window: got ${x509.validFrom} to ${x509.validTo}, ` +
      `wanted ${notBefore.toISOString()} to ${notAfter.toISOString()}`,
    );
  }
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
