/**
 * Regression tests for Veracode flaw 383 (CWE-312, otel-logger.ts emit):
 * the structured logger must not write credentials to stdout (shipped to
 * Log Analytics) or to the OTel log exporter.
 */

import { logs } from "@opentelemetry/api-logs";
import {
  LOG_REDACTED,
  isSensitiveAttributeName,
  redactLogAttributes,
  redactSecretsInText,
} from "../../src/utils/log-redaction.js";
import { info, debug, warn, error } from "../../src/utils/otel-logger.js";

const ACCOUNT_KEY = "c2VjcmV0LWFjY291bnQta2V5LWZvci10ZXN0cw==";
const SAS_SIG = "abcDEF123%2Bxyz%3D";
const BEARER = "eyJhbGciOiJIUzI1NiJ9.payload.signature";

describe("log-redaction", () => {
  it("treats credential attribute names as sensitive", () => {
    for (const name of ["password", "clientSecret", "accessToken", "apiKey", "x-api-key", "xApiKey",
      "authorization", "Cookie", "credential", "sig", "sas", "accountKey", "connectionString", "private_key"]) {
      expect(isSensitiveAttributeName(name), name).toBe(true);
    }
    for (const name of ["component", "error", "tool", "container", "authHeaders", "keyFile"]) {
      expect(isSensitiveAttributeName(name), name).toBe(false);
    }
  });

  it("removes connection-string secrets, SAS signatures and bearer tokens from text", () => {
    const text =
      `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${ACCOUNT_KEY};EndpointSuffix=core.windows.net ` +
      `https://acct.blob.core.windows.net/c/b?sv=2024-01-01&sig=${SAS_SIG}&se=2026 ` +
      `Authorization: Bearer ${BEARER}`;
    const out = redactSecretsInText(text);
    expect(out).not.toContain(ACCOUNT_KEY);
    expect(out).not.toContain(SAS_SIG);
    expect(out).not.toContain(BEARER);
    expect(out).toContain(`AccountKey=${LOG_REDACTED};EndpointSuffix=core.windows.net`);
    expect(out).toContain(`&sig=${LOG_REDACTED}&se=2026`);
    expect(out).toContain(`Bearer ${LOG_REDACTED}`);
    expect(out).toContain("AccountName=acct");
  });

  it("leaves ordinary text unchanged", () => {
    const text = "The specified container does not exist. RequestId:1234";
    expect(redactSecretsInText(text)).toBe(text);
  });

  it("redacts attributes by name and by content, keeping numbers and booleans", () => {
    const out = redactLogAttributes({
      component: "auth",
      apiKey: "plain-key",
      error: `AccountKey=${ACCOUNT_KEY}`,
      count: 3,
      ok: true,
    });
    expect(out).toEqual({
      component: "auth",
      apiKey: LOG_REDACTED,
      error: `AccountKey=${LOG_REDACTED}`,
      count: 3,
      ok: true,
    });
    expect(redactLogAttributes(undefined)).toBeUndefined();
  });
});

describe("otel-logger applies redaction to both sinks", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let emitted: Array<{ body?: unknown; attributes?: unknown }>;
  let getLoggerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    emitted = [];
    getLoggerSpy = vi.spyOn(logs, "getLogger").mockReturnValue({
      emit: (record: { body?: unknown; attributes?: unknown }) => { emitted.push(record); },
    } as unknown as ReturnType<typeof logs.getLogger>);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    getLoggerSpy.mockRestore();
  });

  it.each([
    ["DEBUG", debug, () => logSpy],
    ["INFO", info, () => logSpy],
    ["WARN", warn, () => warnSpy],
    ["ERROR", error, () => errorSpy],
  ] as const)("%s never writes the secret", (_sev, fn, spy) => {
    fn(`Upload failed: AccountKey=${ACCOUNT_KEY}`, { token: BEARER, error: `sig=${SAS_SIG}`, tool: "blob-upload" });

    const stdout = JSON.stringify(spy().mock.calls);
    const otel = JSON.stringify(emitted);
    for (const sink of [stdout, otel]) {
      expect(sink).not.toContain(ACCOUNT_KEY);
      expect(sink).not.toContain(BEARER);
      expect(sink).not.toContain(SAS_SIG);
      expect(sink).toContain("blob-upload");
    }
    expect(emitted).toHaveLength(1);
    expect(emitted[0].body).toBe(`Upload failed: AccountKey=${LOG_REDACTED}`);
  });
});

describe("log-redaction SAS forms", () => {
  it("redacts a bare SAS token string and a connection-string SAS", () => {
    expect(redactSecretsInText("sig=abc123")).toBe(`sig=${LOG_REDACTED}`);
    expect(redactSecretsInText("sv=2024&ss=b&sig=abc%2B1&se=x")).toBe(`sv=2024&ss=b&sig=${LOG_REDACTED}&se=x`);
    expect(redactSecretsInText("SharedAccessSignature=sv=2024&sig=abc;BlobEndpoint=x"))
      .not.toContain("abc");
  });
  it("does not touch words that merely contain sig", () => {
    expect(redactSecretsInText("design=final; assign=x")).toBe("design=final; assign=x");
  });
});

describe("auth middleware debug attribute survives redaction", () => {
  it("keeps authHeaders, the neutral name api-key.ts logs", () => {
    expect(redactLogAttributes({ component: "auth", authHeaders: "x-api-key,authorization" }))
      .toEqual({ component: "auth", authHeaders: "x-api-key,authorization" });
  });
});
