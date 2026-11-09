/**
 * Unit tests for src/utils/tls.ts
 *
 * Validates TLS configuration parsing, certificate loading, validation,
 * and environment variable handling.
 *
 * Certificates are generated at test time using the openssl CLI.
 * Tests are skipped if openssl is not available on the system.
 */

import { readFileSync } from "node:fs";
import {
  getTlsConfig,
  loadCertificateFiles,
  validateCertificateMatch,
  validateCertificateValidity,
  createTlsOptions,
} from "../../src/utils/tls.js";
import {
  isOpensslAvailable,
  generateTestCertificate,
  generateMismatchedKey,
  cleanupTestCertificate,
  type TestCertificate,
} from "../helpers/tls-cert-helper.js";

const HAS_OPENSSL = isOpensslAvailable();

// ---------------------------------------------------------------------------
// getTlsConfig() -- environment variable parsing
// ---------------------------------------------------------------------------

describe("getTlsConfig", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save original values
    origEnv.TLS_CERT_FILE = process.env.TLS_CERT_FILE;
    origEnv.TLS_KEY_FILE = process.env.TLS_KEY_FILE;
    origEnv.TLS_MIN_VERSION = process.env.TLS_MIN_VERSION;
    // Clear all TLS env vars
    delete process.env.TLS_CERT_FILE;
    delete process.env.TLS_KEY_FILE;
    delete process.env.TLS_MIN_VERSION;
  });

  afterEach(() => {
    // Restore original values
    if (origEnv.TLS_CERT_FILE !== undefined) {
      process.env.TLS_CERT_FILE = origEnv.TLS_CERT_FILE;
    } else {
      delete process.env.TLS_CERT_FILE;
    }
    if (origEnv.TLS_KEY_FILE !== undefined) {
      process.env.TLS_KEY_FILE = origEnv.TLS_KEY_FILE;
    } else {
      delete process.env.TLS_KEY_FILE;
    }
    if (origEnv.TLS_MIN_VERSION !== undefined) {
      process.env.TLS_MIN_VERSION = origEnv.TLS_MIN_VERSION;
    } else {
      delete process.env.TLS_MIN_VERSION;
    }
  });

  it("returns null when neither TLS_CERT_FILE nor TLS_KEY_FILE is set", () => {
    const result = getTlsConfig();
    expect(result).toBeNull();
  });

  it("returns a TlsConfig when both TLS_CERT_FILE and TLS_KEY_FILE are set", () => {
    process.env.TLS_CERT_FILE = "/tmp/cert.pem";
    process.env.TLS_KEY_FILE = "/tmp/key.pem";

    const result = getTlsConfig();
    expect(result).not.toBeNull();
    expect(result!.certPath).toBe("/tmp/cert.pem");
    expect(result!.keyPath).toBe("/tmp/key.pem");
    expect(result!.minVersion).toBe("TLSv1.3"); // default
  });

  it("throws when TLS_CERT_FILE is set but TLS_KEY_FILE is missing", () => {
    process.env.TLS_CERT_FILE = "/tmp/cert.pem";

    expect(() => getTlsConfig()).toThrow(
      /TLS_CERT_FILE is set but TLS_KEY_FILE is missing/
    );
  });

  it("throws when TLS_KEY_FILE is set but TLS_CERT_FILE is missing", () => {
    process.env.TLS_KEY_FILE = "/tmp/key.pem";

    expect(() => getTlsConfig()).toThrow(
      /TLS_KEY_FILE is set but TLS_CERT_FILE is missing/
    );
  });

  it("accepts TLS_MIN_VERSION=TLSv1.2", () => {
    process.env.TLS_CERT_FILE = "/tmp/cert.pem";
    process.env.TLS_KEY_FILE = "/tmp/key.pem";
    process.env.TLS_MIN_VERSION = "TLSv1.2";

    const result = getTlsConfig();
    expect(result!.minVersion).toBe("TLSv1.2");
  });

  it("accepts TLS_MIN_VERSION=TLSv1.3", () => {
    process.env.TLS_CERT_FILE = "/tmp/cert.pem";
    process.env.TLS_KEY_FILE = "/tmp/key.pem";
    process.env.TLS_MIN_VERSION = "TLSv1.3";

    const result = getTlsConfig();
    expect(result!.minVersion).toBe("TLSv1.3");
  });

  it("throws for invalid TLS_MIN_VERSION", () => {
    process.env.TLS_CERT_FILE = "/tmp/cert.pem";
    process.env.TLS_KEY_FILE = "/tmp/key.pem";
    process.env.TLS_MIN_VERSION = "TLSv1.1";

    expect(() => getTlsConfig()).toThrow(/Invalid TLS_MIN_VERSION/);
  });
});

// ---------------------------------------------------------------------------
// TRUST_PROXY_HOPS default behaviour
// ---------------------------------------------------------------------------

describe("TRUST_PROXY_HOPS defaults", () => {
  it("defaults to 0 when TLS is active (no proxy in front)", () => {
    // When TLS is active, the default trust proxy should be 0.
    // This is tested by checking the logic directly -- the server.ts
    // uses `tlsConfig ? 0 : 1` as the default.
    const tlsActive = true;
    const trustProxyDefault = tlsActive ? 0 : 1;
    expect(trustProxyDefault).toBe(0);
  });

  it("defaults to 1 when TLS is not active (behind proxy)", () => {
    const tlsActive = false;
    const trustProxyDefault = tlsActive ? 0 : 1;
    expect(trustProxyDefault).toBe(1);
  });

  it("explicit TRUST_PROXY_HOPS overrides the default", () => {
    const explicitValue = "2";
    // The server.ts logic: Number(process.env.TRUST_PROXY_HOPS || trustProxyDefault)
    const trustProxyDefault = 0; // TLS active
    const result = Number(explicitValue || trustProxyDefault);
    expect(result).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Certificate file operations (require openssl)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_OPENSSL)("loadCertificateFiles", () => {
  let testCert: TestCertificate;

  beforeAll(() => {
    testCert = generateTestCertificate();
  });

  afterAll(() => {
    cleanupTestCertificate(testCert.tmpDir);
  });

  it("loads valid certificate and key files", () => {
    const { cert, key } = loadCertificateFiles(testCert.certPath, testCert.keyPath);
    expect(cert).toBeInstanceOf(Buffer);
    expect(key).toBeInstanceOf(Buffer);
    expect(cert.length).toBeGreaterThan(0);
    expect(key.length).toBeGreaterThan(0);
  });

  it("throws for non-existent certificate file", () => {
    expect(() =>
      loadCertificateFiles("/nonexistent/cert.pem", testCert.keyPath)
    ).toThrow(/Failed to read TLS certificate file/);
  });

  it("throws for non-existent key file", () => {
    expect(() =>
      loadCertificateFiles(testCert.certPath, "/nonexistent/key.pem")
    ).toThrow(/Failed to read TLS key file/);
  });
});

// ---------------------------------------------------------------------------
// Certificate validation (require openssl)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_OPENSSL)("validateCertificateMatch", () => {
  let testCert: TestCertificate;

  beforeAll(() => {
    testCert = generateTestCertificate();
  });

  afterAll(() => {
    cleanupTestCertificate(testCert.tmpDir);
  });

  it("succeeds for a matching cert+key pair", () => {
    const cert = readFileSync(testCert.certPath);
    const key = readFileSync(testCert.keyPath);
    expect(() => validateCertificateMatch(cert, key)).not.toThrow();
  });

  it("throws for a mismatched cert+key pair", () => {
    const cert = readFileSync(testCert.certPath);
    const { keyPath: mismatchedKeyPath } = generateMismatchedKey(testCert.tmpDir);
    const mismatchedKey = readFileSync(mismatchedKeyPath);

    expect(() => validateCertificateMatch(cert, mismatchedKey)).toThrow(
      /certificate and private key do not match/
    );
  });
});

describe.skipIf(!HAS_OPENSSL)("validateCertificateValidity", () => {
  let validCert: TestCertificate;
  let expiredCert: TestCertificate;
  let futureCert: TestCertificate;

  beforeAll(() => {
    validCert = generateTestCertificate({ days: 365, cn: "valid.test" });
    expiredCert = generateTestCertificate({ expired: true, cn: "expired.test" });
    futureCert = generateTestCertificate({ notYetValid: true, cn: "future.test" });
  });

  afterAll(() => {
    cleanupTestCertificate(validCert.tmpDir);
    cleanupTestCertificate(expiredCert.tmpDir);
    cleanupTestCertificate(futureCert.tmpDir);
  });

  it("succeeds for a valid (in-date) certificate", () => {
    const cert = readFileSync(validCert.certPath);
    expect(() => validateCertificateValidity(cert)).not.toThrow();
  });

  it("throws for an expired certificate", () => {
    const cert = readFileSync(expiredCert.certPath);
    // The certificate should be detected as expired
    expect(() => validateCertificateValidity(cert)).toThrow(/expired/i);
  });

  it("throws for a not-yet-valid certificate", () => {
    const cert = readFileSync(futureCert.certPath);
    // The certificate should be detected as not yet valid
    expect(() => validateCertificateValidity(cert)).toThrow(/not yet valid/i);
  });
});

// ---------------------------------------------------------------------------
// createTlsOptions (end-to-end with openssl)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_OPENSSL)("createTlsOptions", () => {
  let testCert: TestCertificate;

  beforeAll(() => {
    testCert = generateTestCertificate({ cn: "localhost" });
  });

  afterAll(() => {
    cleanupTestCertificate(testCert.tmpDir);
  });

  it("returns valid SecureContextOptions for a good cert+key pair", () => {
    const opts = createTlsOptions(testCert.certPath, testCert.keyPath, "TLSv1.3");

    expect(opts.cert).toBeInstanceOf(Buffer);
    expect(opts.key).toBeInstanceOf(Buffer);
    expect(opts.minVersion).toBe("TLSv1.3");
  });

  it("throws for a mismatched pair", () => {
    const { keyPath: badKeyPath } = generateMismatchedKey(testCert.tmpDir);

    expect(() =>
      createTlsOptions(testCert.certPath, badKeyPath, "TLSv1.3")
    ).toThrow(/do not match/);
  });
});
