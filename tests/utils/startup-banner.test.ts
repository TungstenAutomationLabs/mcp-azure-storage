/**
 * Regression tests for Veracode flaws 377 to 381 (CWE-312, server.ts
 * printStartupBanner): the banner reports effective, validated state and
 * never copies raw environment strings (TLS file locations, DISABLED_TOOLS,
 * TRUST_PROXY_HOPS) to stdout.
 */

import { buildStartupBanner, toSafeInteger, type StartupBannerOptions } from "../../src/utils/startup-banner.js";
import { parseDisabledTools, splitDisabledTools } from "../../src/utils/disabled-tools.js";

const base: StartupBannerOptions = {
  version: "1.4.1",
  protocol: "https",
  port: 3443,
  tlsMinVersion: "TLSv1.3",
  trustProxyHops: 0,
  trustProxyDefault: 0,
  apiKeyAuth: "ENABLED",
  cors: "DISABLED",
  rateLimitMcpMax: 600,
  rateLimitUploadMax: 600,
  rateLimitWindowSeconds: 60,
  maxJsonBodyBytes: 10 * 1024 * 1024,
  maxUploadBytes: 100 * 1024 * 1024,
  disabledKnownTools: [],
  disabledUnknownCount: 0,
};

describe("buildStartupBanner", () => {
  it("keeps the existing lines in TLS mode", () => {
    const text = buildStartupBanner(base).join("\n");
    expect(text).toContain("MCP Azure Storage Server v1.4.1");
    expect(text).toContain("MCP endpoint : https://localhost:3443/mcp");
    expect(text).toContain("TLS          : ENABLED (min TLSv1.3)");
    expect(text).toContain("Trust proxy  : 0 (default 0 in TLS mode)");
    expect(text).toContain("API key auth : ENABLED");
    expect(text).toContain("JSON limit   : 10mb");
    expect(text).not.toContain("Disabled tools");
  });

  it("does not print the TLS certificate or private key location", () => {
    const lines = buildStartupBanner(base);
    const text = lines.join("\n");
    expect(text).toContain("TLS cert     : loaded from TLS_CERT_FILE");
    expect(text).toContain("TLS key      : loaded from TLS_KEY_FILE");
    // StartupBannerOptions has no path field at all; check nothing path-like leaks.
    // (The health-probe hint's "/path/to/ca.pem" is a fixed placeholder.)
    const withoutHint = lines.filter((l) => !l.includes("Health probe")).join("\n");
    expect(withoutHint).not.toMatch(/\/(etc|mnt|run|var|tmp)\//);
    expect(withoutHint).not.toMatch(/\.(pem|key|crt)\b/);
  });

  it("prints plain HTTP mode without TLS lines", () => {
    const text = buildStartupBanner({ ...base, protocol: "http", tlsMinVersion: null }).join("\n");
    expect(text).toContain("TLS          : DISABLED (plain HTTP)");
    expect(text).not.toContain("TLS cert");
    expect(text).not.toContain("Trust proxy");
  });

  it("reports an unusable trust-proxy value as invalid, not as the raw text", () => {
    const text = buildStartupBanner({ ...base, trustProxyHops: toSafeInteger(Number("abc")) }).join("\n");
    expect(text).toContain("Trust proxy  : invalid");
    expect(text).not.toContain("abc");
  });

  it("lists disabled tools from the catalogue and only counts unknown entries", () => {
    const secretLike = "DefaultEndpointsProtocol=https;AccountKey=c2VjcmV0";
    const disabled = parseDisabledTools(`blob-delete, ${secretLike}, queue-delete`);
    const known = new Set(["blob-upload", "blob-delete", "queue-delete"]);
    const split = splitDisabledTools(disabled, known);
    expect(split).toEqual({ known: ["blob-delete", "queue-delete"], unknownCount: 1 });

    const text = buildStartupBanner({
      ...base,
      disabledKnownTools: split.known,
      disabledUnknownCount: split.unknownCount,
    }).join("\n");
    expect(text).toContain("Disabled tools: blob-delete, queue-delete (+1 unknown, see warnings)");
    expect(text.toLowerCase()).not.toContain("accountkey");
  });

  it("prints the unknown count alone when no known tool is disabled", () => {
    const text = buildStartupBanner({ ...base, disabledUnknownCount: 2 }).join("\n");
    expect(text).toContain("Disabled tools: (+2 unknown, see warnings)");
  });
});

describe("toSafeInteger", () => {
  it("accepts safe integers and digit strings only", () => {
    expect(toSafeInteger(3)).toBe(3);
    expect(toSafeInteger(" 12 ")).toBe(12);
    expect(toSafeInteger(1.5)).toBeNull();
    expect(toSafeInteger(Number.NaN)).toBeNull();
    expect(toSafeInteger("1e3")).toBeNull();
    expect(toSafeInteger("AccountKey=abc")).toBeNull();
    expect(toSafeInteger(undefined)).toBeNull();
    expect(toSafeInteger(true)).toBeNull();
  });
});

describe("startup banner contract", () => {
  it("prints invalid, not the value, for a non-integer limit that slipped through", () => {
    const text = buildStartupBanner({
      ...base,
      // A caller bypassing the types must not get free text into the banner.
      rateLimitMcpMax: "sk-synthetic-limit" as unknown as number,
      maxUploadBytes: Number.NaN,
    }).join("\n");
    expect(text).toContain("Rate limit   : MCP invalid / Upload 600 per 60s");
    expect(text).toContain("Upload limit : invalidmb");
    expect(text).not.toContain("sk-synthetic-limit");
  });
});
