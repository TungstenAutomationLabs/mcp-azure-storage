/**
 * Unit tests for src/utils/otel-logger.ts
 *
 * Verifies stdout output, graceful handling when no OTel provider is
 * registered, and severity level filtering.
 */

import { info, warn, error, debug } from "../../src/utils/otel-logger.js";

describe("otel-logger", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    delete process.env.OTEL_LOG_MIN_SEVERITY;
  });

  describe("stdout output", () => {
    it("writes INFO messages to console.log", () => {
      info("server started");
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const call = consoleSpy.mock.calls[0];
      expect(call[0]).toContain("INFO:");
      expect(call[1]).toBe("server started");
    });

    it("writes WARN messages to console.warn", () => {
      warn("rate limit approaching");
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const call = consoleWarnSpy.mock.calls[0];
      expect(call[0]).toContain("WARN:");
      expect(call[1]).toBe("rate limit approaching");
    });

    it("writes ERROR messages to console.error", () => {
      error("connection failed");
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const call = consoleErrorSpy.mock.calls[0];
      expect(call[0]).toContain("ERROR:");
      expect(call[1]).toBe("connection failed");
    });

    it("writes DEBUG messages to console.log", () => {
      debug("trace detail");
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const call = consoleSpy.mock.calls[0];
      expect(call[0]).toContain("DEBUG:");
      expect(call[1]).toBe("trace detail");
    });

    it("includes attributes in output", () => {
      info("tool called", { tool: "blob-read", duration: 42 });
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const call = consoleSpy.mock.calls[0];
      expect(call[2]).toEqual({ tool: "blob-read", duration: 42 });
    });
  });

  describe("missing OTel provider (no-op)", () => {
    it("does not throw when no OTel provider is registered", () => {
      // With no SDK initialised, the logs API returns a no-op logger.
      // This should not throw.
      expect(() => info("safe call")).not.toThrow();
      expect(() => warn("safe warning")).not.toThrow();
      expect(() => error("safe error")).not.toThrow();
      expect(() => debug("safe debug")).not.toThrow();
    });

    it("still writes to stdout even without OTel provider", () => {
      info("output preserved");
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("severity level filtering", () => {
    it("respects OTEL_LOG_MIN_SEVERITY=ERROR (filters out INFO from console)", () => {
      process.env.OTEL_LOG_MIN_SEVERITY = "ERROR";
      info("should be filtered");
      expect(consoleSpy).toHaveBeenCalledTimes(0);
    });

    it("filters DEBUG and INFO when min severity is WARN", () => {
      process.env.OTEL_LOG_MIN_SEVERITY = "WARN";
      debug("filtered");
      info("filtered");
      expect(consoleSpy).toHaveBeenCalledTimes(0);
    });

    it("allows messages at or above the minimum severity", () => {
      process.env.OTEL_LOG_MIN_SEVERITY = "WARN";
      warn("should pass filter");
      error("should pass filter");
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    it("allows all levels when OTEL_LOG_MIN_SEVERITY is not set", () => {
      delete process.env.OTEL_LOG_MIN_SEVERITY;
      debug("allowed");
      info("allowed");
      warn("allowed");
      error("allowed");
      expect(consoleSpy).toHaveBeenCalledTimes(2); // DEBUG + INFO
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });
  });
});
