/**
 * Security regression tests against the real server (src/server.ts run as a
 * child process), for the Veracode findings on build 79047484:
 *
 *  - 384 / 377-381 (CWE-312, printStartupBanner): startup stdout and stderr
 *    never contain secrets or secret-bearing configuration, in HTTP, TLS,
 *    minimal and invalid configurations;
 *  - 382 (CWE-798, getRateLimitKey) and the throttling gap beside it: every
 *    /mcp and /upload request is rate limited, including ones with a missing
 *    or wrong key, and rotating keys or spoofing X-Forwarded-For opens no
 *    new budget.
 *
 * No Azure Storage is contacted.
 */

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postMcp, runServerToExit, startServerProcess, type ServerProcess } from "./helpers/server-process.js";
import { cleanupTestCertificate, generateTestCertificate, isOpensslAvailable } from "./helpers/tls-cert-helper.js";

// Synthetic secrets: each must never appear in any output.
const API_KEY = "synth-mcp-api-key-7Q2w9E";
const ACCOUNT_KEY = "c3ludGgtYWNjb3VudC1rZXktWjhYMw==";
const SAS_SIG = "synthSasSig%2B4R7t";
const MARK = "synthmarker5V8n";

const SECRETS = [API_KEY, ACCOUNT_KEY, SAS_SIG, MARK];

function expectNoSecrets(output: string): void {
  // Case-insensitive: some values (DISABLED_TOOLS) are lowercased before printing.
  const lower = output.toLowerCase();
  for (const s of SECRETS) expect(lower, `output must not contain ${s}`).not.toContain(s.toLowerCase());
}

/** Environment carrying synthetic secrets in every variable the server reads at startup. */
const SECRET_ENV = {
  MCP_API_KEY: API_KEY,
  AZURE_STORAGE_ACCOUNT_KEY: ACCOUNT_KEY,
  AZURE_BLOB_SERVICE_URL: `https://acct.blob.core.windows.net/?sv=2024-01-01&sig=${SAS_SIG}`,
  AZURE_QUEUE_SERVICE_URL: `https://u:${MARK}@acct.queue.core.windows.net`,
  // Values pasted into the wrong variables:
  DISABLED_TOOLS: `blob-delete,${MARK},DefaultEndpointsProtocol=https;AccountKey=${ACCOUNT_KEY}`,
  TRUST_PROXY_HOPS: MARK,
  CORS_ENABLED: MARK,
  OTEL_SCRUB_HMAC_KEY: MARK,
  UNRELATED_CONNECTION_STRING: `DefaultEndpointsProtocol=https;AccountName=a;AccountKey=${ACCOUNT_KEY}`,
};

describe("startup output (CWE-312)", () => {
  it("HTTP mode: prints useful state and no secret", async () => {
    const s = await startServerProcess(SECRET_ENV);
    try {
      // A request that fails auth writes the auth log records too.
      await postMcp(s.baseUrl, { "x-api-key": `${API_KEY}-wrong` });
      await postMcp(s.baseUrl, { authorization: `Bearer ${API_KEY}` });
      await new Promise((r) => setTimeout(r, 200));
      const out = s.output();
      expectNoSecrets(out);
      expect(out).toContain("API key auth : ENABLED");
      expect(out).toContain("TLS          : DISABLED (plain HTTP)");
      expect(out).toContain("Disabled tools: blob-delete (+2 unknown, see warnings)");
      expect(out).toContain("DISABLED_TOOLS contains entries that match no tool");
    } finally {
      await s.stop();
    }
  }, 30_000);

  it.skipIf(!isOpensslAvailable())("TLS mode: no certificate or key location, allowlisted min version", async () => {
    const cert = generateTestCertificate({ cn: "localhost" });
    const dir = mkdtempSync(join(tmpdir(), `mcp-${MARK}-`));
    copyFileSync(cert.certPath, join(dir, `${MARK}-cert.pem`));
    copyFileSync(cert.keyPath, join(dir, `${MARK}-key.pem`));
    let s: ServerProcess | undefined;
    try {
      s = await startServerProcess({
        ...SECRET_ENV,
        TLS_CERT_FILE: join(dir, `${MARK}-cert.pem`),
        TLS_KEY_FILE: join(dir, `${MARK}-key.pem`),
        TLS_MIN_VERSION: "TLSv1.2",
      }, { protocol: "https" });
      const out = s.output();
      expectNoSecrets(out);
      expect(out).not.toContain(dir);
      expect(out).toContain("TLS          : ENABLED (min TLSv1.2)");
      expect(out).toContain("TLS key      : loaded from TLS_KEY_FILE");
      expect(out).toContain("Trust proxy  : invalid");
    } finally {
      await s?.stop();
      rmSync(dir, { recursive: true, force: true });
      cleanupTestCertificate(cert.tmpDir);
    }
  }, 30_000);

  it("minimal configuration: starts without MCP_API_KEY and says so", async () => {
    const s = await startServerProcess({ MCP_API_KEY: undefined, AZURE_STORAGE_ACCOUNT_KEY: ACCOUNT_KEY });
    try {
      const out = s.output();
      expectNoSecrets(out);
      expect(out).toContain("API key auth : DISABLED (set MCP_API_KEY)");
      expect(out).not.toContain("Disabled tools");
    } finally {
      await s.stop();
    }
  }, 30_000);

  it("invalid configuration: the error names the variable, not its value", async () => {
    const r = await runServerToExit({ ...SECRET_ENV, TLS_CERT_FILE: "/nonexistent/c.pem",
      TLS_KEY_FILE: "/nonexistent/k.pem", TLS_MIN_VERSION: MARK });
    expect(r.exited).toBe(true);
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("Invalid TLS_MIN_VERSION");
    expectNoSecrets(r.output);
  }, 30_000);
});

/** Statuses of `n` sequential /mcp requests. */
async function statuses(s: ServerProcess, n: number, headers: (i: number) => Record<string, string>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(await postMcp(s.baseUrl, headers(i)));
  return out;
}

describe("rate limiting covers unauthenticated requests (CWE-798 finding 382 area)", () => {
  const LIMITS = { RATE_LIMIT_MCP_MAX: "3", RATE_LIMIT_UPLOAD_MAX: "2", RATE_LIMIT_WINDOW_SECONDS: "60", TRUST_PROXY_HOPS: "0" };

  it("throttles wrong and missing keys per address, without locking out the valid key", async () => {
    const s = await startServerProcess({ MCP_API_KEY: API_KEY, ...LIMITS });
    try {
      // Rotating wrong keys: three are judged (403), then throttled (429).
      expect(await statuses(s, 5, (i) => ({ "x-api-key": `guess-${i}` }))).toEqual([403, 403, 403, 429, 429]);
      // Missing key and malformed keys share the same address budget.
      expect(await postMcp(s.baseUrl)).toBe(429);
      expect(await postMcp(s.baseUrl, { "x-api-key": "abcé" })).toBe(429);
      // Spoofed X-Forwarded-For is not believed with TRUST_PROXY_HOPS=0.
      expect(await statuses(s, 3, (i) => ({ "x-api-key": "x", "x-forwarded-for": `198.51.100.${i}` })))
        .toEqual([429, 429, 429]);
      // The configured key has its own budget and still works.
      expect(await postMcp(s.baseUrl, { "x-api-key": API_KEY })).toBe(200);
      expect(await postMcp(s.baseUrl, { authorization: `Bearer ${API_KEY}` })).toBe(200);
    } finally {
      await s.stop();
    }
  }, 30_000);

  it("enforces the limit for the valid key too", async () => {
    const s = await startServerProcess({ MCP_API_KEY: API_KEY, ...LIMITS });
    try {
      expect(await statuses(s, 5, () => ({ "x-api-key": API_KEY }))).toEqual([200, 200, 200, 429, 429]);
    } finally {
      await s.stop();
    }
  }, 30_000);

  it("throttles when MCP_API_KEY is unset (auth fails closed) and keys are rotated", async () => {
    const s = await startServerProcess({ MCP_API_KEY: undefined, ...LIMITS });
    try {
      expect(await statuses(s, 5, (i) => ({ "x-api-key": `k-${i}` }))).toEqual([503, 503, 503, 429, 429]);
    } finally {
      await s.stop();
    }
  }, 30_000);

  it("counts concurrent requests exactly", async () => {
    const s = await startServerProcess({ MCP_API_KEY: API_KEY, ...LIMITS, RATE_LIMIT_MCP_MAX: "5" });
    try {
      const results = await Promise.all(Array.from({ length: 25 }, (_, i) => postMcp(s.baseUrl, { "x-api-key": `c-${i}` })));
      expect(results.filter((c) => c === 403)).toHaveLength(5);
      expect(results.filter((c) => c === 429)).toHaveLength(20);
    } finally {
      await s.stop();
    }
  }, 30_000);

  it("resets after the window", async () => {
    const s = await startServerProcess({ MCP_API_KEY: API_KEY, ...LIMITS, RATE_LIMIT_WINDOW_SECONDS: "2" });
    try {
      expect(await statuses(s, 4, () => ({ "x-api-key": "wrong" }))).toEqual([403, 403, 403, 429]);
      await new Promise((r) => setTimeout(r, 2300));
      expect(await postMcp(s.baseUrl, { "x-api-key": "wrong" })).toBe(403);
    } finally {
      await s.stop();
    }
  }, 30_000);

  it("throttles /upload attempts with a wrong key", async () => {
    const s = await startServerProcess({ MCP_API_KEY: API_KEY, ...LIMITS });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await fetch(`${s.baseUrl}/upload`, { method: "POST", headers: { "x-api-key": `u-${i}` } });
        await res.arrayBuffer();
        codes.push(res.status);
      }
      expect(codes).toEqual([403, 403, 429, 429]);
    } finally {
      await s.stop();
    }
  }, 30_000);
});

describe("MCP contract through the reordered middleware", () => {
  it("lists tools for the valid key and still hides DISABLED_TOOLS", async () => {
    const s = await startServerProcess({ MCP_API_KEY: API_KEY, DISABLED_TOOLS: "blob-delete" });
    try {
      const res = await fetch(`${s.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": API_KEY },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(200);
      const raw = await res.text();
      // JSON or a single SSE "data:" event, depending on the transport's choice.
      const json = JSON.parse(raw.trim().startsWith("{") ? raw : raw.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
      const names: string[] = json.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("blob-list");
      expect(names).toContain("store-info");
      expect(names).not.toContain("blob-delete");
      expect(names.length).toBeGreaterThan(30);
    } finally {
      await s.stop();
    }
  }, 30_000);
});
