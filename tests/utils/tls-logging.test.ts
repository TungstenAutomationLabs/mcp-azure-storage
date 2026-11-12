/**
 * Regression test for the TLS part of Veracode flaw 383 (CWE-312,
 * otel-logger.ts emit): certificate reload and watcher records must not
 * carry the TLS certificate or private key location from TLS_CERT_FILE /
 * TLS_KEY_FILE into stdout or telemetry.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type https from "node:https";
import { watchCertificates } from "../../src/utils/tls.js";
import {
  cleanupTestCertificate,
  generateTestCertificate,
  isOpensslAvailable,
} from "../helpers/tls-cert-helper.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!isOpensslAvailable())("TLS watcher logging", () => {
  it("logs reloads and the watcher without file or directory paths", async () => {
    const cert = generateTestCertificate({ cn: "localhost" });
    const spies = (["log", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const fakeServer = { setSecureContext: vi.fn() } as unknown as https.Server;
    const watcher = watchCertificates(fakeServer, cert.certPath, cert.keyPath, "TLSv1.3");
    try {
      // Rewrite the same pair to trigger a successful reload.
      writeFileSync(cert.certPath, readFileSync(cert.certPath));
      await sleep(1600);
      const out = JSON.stringify(spies.map((s) => s.mock.calls));
      expect(out).toContain("Certificate file watcher active");
      expect(out).toContain("TLS certificates reloaded successfully");
      expect(out).not.toContain(cert.tmpDir);
      expect(out).not.toContain("key.pem");
      expect(out).not.toContain("cert.pem");
    } finally {
      watcher.close();
      spies.forEach((s) => s.mockRestore());
      cleanupTestCertificate(cert.tmpDir);
    }
  }, 10_000);
});
