/**
 * Startup banner text.
 *
 * The banner goes to stdout, which Azure Container Apps ships to Log
 * Analytics. Its contract is that it prints only values that cannot carry a
 * secret, whatever the environment holds:
 *
 *  - fixed state words (`ENABLED` / `DISABLED`) and allowlisted constants
 *    (`TLSv1.2` / `TLSv1.3`), never the environment string they came from;
 *  - safe integers (port, limits, proxy hops), or `invalid`;
 *  - the application version from package.json;
 *  - names from the server's own tool catalogue (never DISABLED_TOOLS text),
 *    and a count of the entries that match no tool.
 *
 * It never prints a path, URL, account name, key or connection string. The
 * types below are the contract: a caller cannot pass a free-form string.
 *
 * @module utils/startup-banner
 */

/** A feature state as printed. */
export type FeatureState = "ENABLED" | "DISABLED";

/** Inputs for the banner. */
export interface StartupBannerOptions {
  version: string;
  protocol: "http" | "https";
  port: number;
  /** Null in plain HTTP mode. */
  tlsMinVersion: "TLSv1.2" | "TLSv1.3" | null;
  /** The value Express is using for "trust proxy", or null when not a safe integer. */
  trustProxyHops: number | null;
  trustProxyDefault: 0 | 1;
  apiKeyAuth: FeatureState;
  cors: FeatureState;
  rateLimitMcpMax: number;
  rateLimitUploadMax: number;
  rateLimitWindowSeconds: number;
  maxJsonBodyBytes: number;
  maxUploadBytes: number;
  /** Disabled tools, as names taken from the server's tool catalogue. */
  disabledKnownTools: readonly string[];
  /** DISABLED_TOOLS entries that match no tool (reported as a warning). */
  disabledUnknownCount: number;
}

/**
 * Return `value` as a safe integer, or null. Accepts a number or a string of
 * decimal digits (optionally signed); anything else is null.
 */
export function toSafeInteger(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "string" && /^[+-]?\d{1,15}$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

/** Print an integer, or `invalid`. */
function int(value: number | null): string {
  const n = toSafeInteger(value);
  return n === null ? "invalid" : String(n);
}

/** Print a byte count in whole MiB, or `invalid`. */
function mib(bytes: number): string {
  const n = toSafeInteger(bytes);
  return n === null ? "invalid" : (n / (1024 * 1024)).toFixed(0);
}

/** Build the banner as lines, without printing them. */
export function buildStartupBanner(o: StartupBannerOptions): string[] {
  const port = int(o.port);
  const lines: string[] = [
    `\n  MCP Azure Storage Server v${o.version}`,
    `   MCP endpoint : ${o.protocol}://localhost:${port}/mcp`,
    `   Upload       : ${o.protocol}://localhost:${port}/upload`,
    `   Health check : ${o.protocol}://localhost:${port}/health`,
    `   Mode         : Stateless (per-request, multi-replica safe)`,
  ];
  if (o.tlsMinVersion) {
    lines.push(
      `   TLS          : ENABLED (min ${o.tlsMinVersion})`,
      `   TLS cert     : loaded from TLS_CERT_FILE`,
      `   TLS key      : loaded from TLS_KEY_FILE`,
      `   Trust proxy  : ${int(o.trustProxyHops)} (default ${o.trustProxyDefault} in TLS mode)`,
      // Health check hint for Docker images without curl
      `   Health probe : NODE_EXTRA_CA_CERTS=/path/to/ca.pem node -e "fetch('https://localhost:${port}/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"`,
    );
  } else {
    lines.push(`   TLS          : DISABLED (plain HTTP)`);
  }
  lines.push(
    `   API key auth : ${o.apiKeyAuth === "ENABLED" ? "ENABLED" : "DISABLED (set MCP_API_KEY)"}`,
    `   CORS         : ${o.cors === "ENABLED" ? "ENABLED" : "DISABLED"}`,
    `   Rate limit   : MCP ${int(o.rateLimitMcpMax)} / Upload ${int(o.rateLimitUploadMax)} per ${int(o.rateLimitWindowSeconds)}s (API-key-aware)`,
    `   JSON limit   : ${mib(o.maxJsonBodyBytes)}mb`,
    `   Upload limit : ${mib(o.maxUploadBytes)}mb (streaming to Azure)`,
  );
  const unknownCount = toSafeInteger(o.disabledUnknownCount) ?? 0;
  if (o.disabledKnownTools.length > 0 || unknownCount > 0) {
    const unknown = unknownCount > 0
      ? `${o.disabledKnownTools.length > 0 ? " " : ""}(+${unknownCount} unknown, see warnings)`
      : "";
    lines.push(`   Disabled tools: ${o.disabledKnownTools.join(", ")}${unknown}`);
  }
  lines.push(""); // trailing newline
  return lines;
}
