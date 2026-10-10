/**
 * Unit tests for src/instrumentation.cjs
 *
 * Verifies the activation guard -- the module can be required without
 * error when OTEL_EXPORTER_OTLP_ENDPOINT is not set.  This is a
 * minimal test; we do not start the full SDK in unit tests.
 */

import { createRequire } from "module";
import { execSync } from "child_process";
import path from "path";

describe("instrumentation.cjs activation guard", () => {
  it("exits silently when OTEL_EXPORTER_OTLP_ENDPOINT is not set", () => {
    // Run the instrumentation file in a subprocess with no OTLP endpoint.
    // It should exit with code 0 and produce no error output.
    const cjsPath = path.resolve("src/instrumentation.cjs");
    const result = execSync(
      `node -e "delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT; require('${cjsPath.replace(/\\/g, "\\\\")}')"`,
      {
        env: {
          ...process.env,
          OTEL_EXPORTER_OTLP_ENDPOINT: "",
        },
        encoding: "utf8",
        timeout: 10000,
      }
    );
    // No output expected -- the guard should exit immediately.
    expect(result.trim()).toBe("");
  });

  it("exits silently when OTEL_TELEMETRY_LEVEL is off", () => {
    const cjsPath = path.resolve("src/instrumentation.cjs");
    const result = execSync(
      `node -e "require('${cjsPath.replace(/\\/g, "\\\\")}')"`,
      {
        env: {
          ...process.env,
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
          OTEL_TELEMETRY_LEVEL: "off",
        },
        encoding: "utf8",
        timeout: 10000,
      }
    );
    expect(result.trim()).toBe("");
  });
});
