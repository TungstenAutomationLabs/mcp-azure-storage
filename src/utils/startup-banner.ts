/**
 * Startup banner text.
 *
 * The banner goes to stdout, which Azure Container Apps ships to Log
 * Analytics. It reports the server's effective, validated state, never raw
 * environment strings: an operator who pastes a secret into the wrong
 * variable must not see it copied into the logs. In particular it does not
 * print where the TLS private key and certificate live on disc, and it lists
 * disabled tools from the server's own tool catalogue rather than echoing
 * DISABLED_TOOLS.
 *
 * @module utils/startup-banner
 */

/** Inputs for the banner, all already parsed and validated by the caller. */
export interface StartupBannerOptions {
  version: string;
  protocol: "http" | "https";
  port: number;
  /** Null in plain HTTP mode. */
  tlsMinVersion: "TLSv1.2" | "TLSv1.3" | null;
  /** The value Express is using for "trust proxy". */
  trustProxyHops: number;
  trustProxyDefault: number;
  apiKeyAuthEnabled: boolean;
  corsEnabled: boolean;
  rateLimitMcpMax: number;
  rateLimitUploadMax: number;
  rateLimitWindowSeconds: number;
  maxJsonBodyBytes: number;
  maxUploadBytes: number;
  /** Disabled tools that are in the server's catalogue. */
  disabledKnownTools: readonly string[];
  /** DISABLED_TOOLS entries that match no tool (reported as warnings). */
  disabledUnknownCount: number;
}

/** Build the banner as lines, without printing them. */
export function buildStartupBanner(o: StartupBannerOptions): string[] {
  const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(0);
  const trustProxy = Number.isFinite(o.trustProxyHops) ? String(o.trustProxyHops) : "invalid";
  const lines: string[] = [
    `\n  MCP Azure Storage Server v${o.version}`,
    `   MCP endpoint : ${o.protocol}://localhost:${o.port}/mcp`,
    `   Upload       : ${o.protocol}://localhost:${o.port}/upload`,
    `   Health check : ${o.protocol}://localhost:${o.port}/health`,
    `   Mode         : Stateless (per-request, multi-replica safe)`,
  ];
  if (o.tlsMinVersion) {
    lines.push(
      `   TLS          : ENABLED (min ${o.tlsMinVersion})`,
      `   TLS cert     : loaded from TLS_CERT_FILE`,
      `   TLS key      : loaded from TLS_KEY_FILE`,
      `   Trust proxy  : ${trustProxy} (default ${o.trustProxyDefault} in TLS mode)`,
      // Health check hint for Docker images without curl
      `   Health probe : NODE_EXTRA_CA_CERTS=/path/to/ca.pem node -e "fetch('https://localhost:${o.port}/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"`,
    );
  } else {
    lines.push(`   TLS          : DISABLED (plain HTTP)`);
  }
  lines.push(
    `   API key auth : ${o.apiKeyAuthEnabled ? "ENABLED" : "DISABLED (set MCP_API_KEY)"}`,
    `   CORS         : ${o.corsEnabled ? "ENABLED" : "DISABLED"}`,
    `   Rate limit   : MCP ${o.rateLimitMcpMax} / Upload ${o.rateLimitUploadMax} per ${o.rateLimitWindowSeconds}s (API-key-aware)`,
    `   JSON limit   : ${mb(o.maxJsonBodyBytes)}mb`,
    `   Upload limit : ${mb(o.maxUploadBytes)}mb (streaming to Azure)`,
  );
  if (o.disabledKnownTools.length > 0 || o.disabledUnknownCount > 0) {
    const unknown = o.disabledUnknownCount > 0
      ? `${o.disabledKnownTools.length > 0 ? " " : ""}(+${o.disabledUnknownCount} unknown, see warnings)`
      : "";
    lines.push(`   Disabled tools: ${o.disabledKnownTools.join(", ")}${unknown}`);
  }
  lines.push(""); // trailing newline
  return lines;
}
