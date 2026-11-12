/**
 * TLS certificate handling against real OpenSSL-generated files, plus checks
 * that the test fixtures are what they claim to be.
 *
 * The fixture checks exist because the helper once depended on
 * `openssl x509 -not_before` (OpenSSL 3.4+) and, on an older openssl,
 * silently produced a currently valid certificate for "not yet valid", so
 * the not-yet-valid test failed for a reason that had nothing to do with
 * the code under test. Dates are relative to now, so nothing here expires.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { join } from "node:path";
import type https from "node:https";
import { createTlsOptions, getTlsConfig, watchCertificates } from "../../src/utils/tls.js";
import {
  cleanupTestCertificate,
  generateTestCertificate,
  isOpensslAvailable,
  type TestCertificate,
} from "../helpers/tls-cert-helper.js";

const DAY = 24 * 60 * 60 * 1000;
const HAS_OPENSSL = isOpensslAvailable();

describe.skipIf(!HAS_OPENSSL)("test certificate fixtures", () => {
  let valid: TestCertificate;
  let expired: TestCertificate;
  let future: TestCertificate;

  beforeAll(() => {
    valid = generateTestCertificate({ cn: "valid.test" });
    expired = generateTestCertificate({ expired: true, cn: "expired.test" });
    future = generateTestCertificate({ notYetValid: true, cn: "future.test" });
  });
  afterAll(() => [valid, expired, future].forEach((c) => cleanupTestCertificate(c.tmpDir)));

  it("valid: in date now, P-256 key, SAN for its name", () => {
    const x = new X509Certificate(valid.certPem);
    const now = Date.now();
    expect(new Date(x.validFrom).getTime()).toBeLessThanOrEqual(now);
    expect(new Date(x.validTo).getTime()).toBeGreaterThan(now + 300 * DAY);
    expect(x.subjectAltName).toContain("DNS:valid.test");
    const key = createPrivateKey(valid.keyPem);
    expect(key.asymmetricKeyType).toBe("ec");
    expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  });

  it("expired: ended about a day ago, relative to now", () => {
    const x = new X509Certificate(expired.certPem);
    const now = Date.now();
    const to = new Date(x.validTo).getTime();
    expect(to).toBeLessThan(now - DAY + 60_000);
    expect(to).toBeGreaterThan(now - DAY - 60_000);
    expect(x.ca).toBe(false);
    expect(x.subjectAltName).toContain("DNS:expired.test");
    expect(x.checkPrivateKey(createPrivateKey(expired.keyPem))).toBe(true);
  });

  it("not yet valid: starts about a year from now, relative to now", () => {
    const x = new X509Certificate(future.certPem);
    const now = Date.now();
    const from = new Date(x.validFrom).getTime();
    expect(from).toBeGreaterThan(now + 364 * DAY);
    expect(from).toBeLessThan(now + 366 * DAY);
    expect(x.ca).toBe(false);
    expect(x.keyUsage ?? []).toContain("1.3.6.1.5.5.7.3.1"); // extendedKeyUsage serverAuth
  });
});

describe.skipIf(!HAS_OPENSSL)("createTlsOptions with real files", () => {
  let valid: TestCertificate;
  let expired: TestCertificate;
  let future: TestCertificate;

  beforeAll(() => {
    valid = generateTestCertificate({ cn: "localhost" });
    expired = generateTestCertificate({ expired: true, cn: "localhost" });
    future = generateTestCertificate({ notYetValid: true, cn: "localhost" });
  });
  afterAll(() => [valid, expired, future].forEach((c) => cleanupTestCertificate(c.tmpDir)));

  it("loads a valid pair with the requested minimum version", () => {
    const opts = createTlsOptions(valid.certPath, valid.keyPath, "TLSv1.3");
    expect(opts.minVersion).toBe("TLSv1.3");
    expect(Buffer.isBuffer(opts.cert)).toBe(true);
  });

  it("refuses an expired certificate", () => {
    expect(() => createTlsOptions(expired.certPath, expired.keyPath, "TLSv1.3")).toThrow(/expired/i);
  });

  it("refuses a not-yet-valid certificate", () => {
    expect(() => createTlsOptions(future.certPath, future.keyPath, "TLSv1.3")).toThrow(/not yet valid/i);
  });

  it("refuses a malformed certificate or key without echoing the file contents", () => {
    const badCert = join(valid.tmpDir, "bad-cert.pem");
    const badKey = join(valid.tmpDir, "bad-key.pem");
    writeFileSync(badCert, "-----BEGIN CERTIFICATE-----\nbm90LWEtY2VydA==\n-----END CERTIFICATE-----\n");
    writeFileSync(badKey, "not a key at all");
    let certErr = "";
    try { createTlsOptions(badCert, valid.keyPath, "TLSv1.3"); } catch (e) { certErr = String(e); }
    let keyErr = "";
    try { createTlsOptions(valid.certPath, badKey, "TLSv1.3"); } catch (e) { keyErr = String(e); }
    expect(certErr).not.toBe("");
    expect(keyErr).not.toBe("");
    // The real private key never appears in an error, whichever file is bad.
    const keyBody = valid.keyPem.split("\n")[1];
    expect(certErr).not.toContain(keyBody);
    expect(keyErr).not.toContain(keyBody);
    expect(keyErr).not.toContain("not a key at all");
  });

  it("refuses a missing file", () => {
    expect(() => createTlsOptions(join(valid.tmpDir, "missing.pem"), valid.keyPath, "TLSv1.3"))
      .toThrow(/Failed to read TLS certificate file/);
  });
});

describe("getTlsConfig rejects invalid settings without echoing them", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it("names TLS_MIN_VERSION but not the rejected value", () => {
    process.env.TLS_CERT_FILE = "/c.pem";
    process.env.TLS_KEY_FILE = "/k.pem";
    process.env.TLS_MIN_VERSION = "synthetic-wrong-value-77";
    let msg = "";
    try { getTlsConfig(); } catch (e) { msg = String(e); }
    expect(msg).toContain("Invalid TLS_MIN_VERSION");
    expect(msg).not.toContain("synthetic-wrong-value-77");
  });

  it("returns the allowlisted constant, not the environment string", () => {
    process.env.TLS_CERT_FILE = "/c.pem";
    process.env.TLS_KEY_FILE = "/k.pem";
    process.env.TLS_MIN_VERSION = "TLSv1.2";
    expect(getTlsConfig()?.minVersion).toBe("TLSv1.2");
  });
});

describe.skipIf(!HAS_OPENSSL)("certificate reload keeps the current certificate when the new one is expired", () => {
  it("does not install an expired renewal and logs no path", async () => {
    const current = generateTestCertificate({ cn: "localhost" });
    const renewal = generateTestCertificate({ expired: true, cn: "localhost" });
    const spies = (["log", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const setSecureContext = vi.fn();
    const watcher = watchCertificates({ setSecureContext } as unknown as https.Server,
      current.certPath, current.keyPath, "TLSv1.3");
    try {
      writeFileSync(current.certPath, readFileSync(renewal.certPath));
      writeFileSync(current.keyPath, readFileSync(renewal.keyPath));
      await new Promise((r) => setTimeout(r, 1600));
      expect(setSecureContext).not.toHaveBeenCalled();
      const out = JSON.stringify(spies.map((s) => s.mock.calls));
      expect(out).toContain("TLS certificate reload failed; keeping existing certificate");
      expect(out).toMatch(/expired/i);
      expect(out).not.toContain(current.keyPem.split("\n")[1]);
    } finally {
      watcher.close();
      spies.forEach((s) => s.mockRestore());
      cleanupTestCertificate(current.tmpDir);
      cleanupTestCertificate(renewal.tmpDir);
    }
  }, 10_000);
});
