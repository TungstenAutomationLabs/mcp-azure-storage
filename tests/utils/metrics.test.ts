/**
 * Tests for src/utils/metrics.ts.
 *
 * Verifies that the metrics utility functions correctly interact with
 * the OTel API and degrade gracefully when OTel is not configured.
 *
 * Uses vi.spyOn on the real @opentelemetry/api metrics object rather
 * than vi.mock to avoid interfering with vitest internals.
 */

import { metrics } from "@opentelemetry/api";
import {
  recordRequest,
  recordError,
  recordStaleSession,
  recordServerStart,
  sanitiseToolName,
  KNOWN_TOOLS,
  _resetForTesting,
} from "../../src/utils/metrics.js";

// -- Shared mock state --------------------------------------------------------

let mockCounterAdd: ReturnType<typeof vi.fn>;
let mockCreateCounter: ReturnType<typeof vi.fn>;

describe("metrics utility", () => {
  beforeEach(() => {
    _resetForTesting();

    // Create fresh mock functions for each test
    mockCounterAdd = vi.fn();
    mockCreateCounter = vi.fn(() => ({ add: mockCounterAdd }));

    // Spy on metrics.getMeter to return a mock meter
    vi.spyOn(metrics, "getMeter").mockReturnValue({
      createCounter: mockCreateCounter,
      createHistogram: vi.fn(),
      createUpDownCounter: vi.fn(),
      createObservableCounter: vi.fn(),
      createObservableUpDownCounter: vi.fn(),
      createObservableGauge: vi.fn(),
      createGauge: vi.fn(),
      addBatchObservableCallback: vi.fn(),
      removeBatchObservableCallback: vi.fn(),
    } as any);
  });

  afterEach(() => {
    _resetForTesting();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // sanitiseToolName
  // -------------------------------------------------------------------------

  describe("sanitiseToolName", () => {
    it("returns a known tool name unchanged", () => {
      expect(sanitiseToolName("blob-read")).toBe("blob-read");
      expect(sanitiseToolName("store-info")).toBe("store-info");
      expect(sanitiseToolName("queue-create")).toBe("queue-create");
    });

    it('returns "unknown" for an unrecognised tool name', () => {
      expect(sanitiseToolName("some_injected_value")).toBe("unknown");
      expect(sanitiseToolName("DROP TABLE users")).toBe("unknown");
      expect(sanitiseToolName("../../etc/passwd")).toBe("unknown");
    });

    it('returns "unknown" for undefined', () => {
      expect(sanitiseToolName(undefined)).toBe("unknown");
    });

    it('returns "unknown" for an empty string', () => {
      expect(sanitiseToolName("")).toBe("unknown");
    });
  });

  // -------------------------------------------------------------------------
  // KNOWN_TOOLS
  // -------------------------------------------------------------------------

  describe("KNOWN_TOOLS", () => {
    it("contains all expected tool categories", () => {
      expect(KNOWN_TOOLS.has("blob-create")).toBe(true);
      expect(KNOWN_TOOLS.has("fileshare-upload-file")).toBe(true);
      expect(KNOWN_TOOLS.has("queue-send-message")).toBe(true);
      expect(KNOWN_TOOLS.has("table-entity-upsert")).toBe(true);
      expect(KNOWN_TOOLS.has("util-to-base64")).toBe(true);
      expect(KNOWN_TOOLS.has("store-info")).toBe(true);
    });

    it("has exactly 43 known tools", () => {
      // 14 + 8 + 8 + 5 + 8 = 43
      expect(KNOWN_TOOLS.size).toBe(43);
    });
  });

  // -------------------------------------------------------------------------
  // recordRequest
  // -------------------------------------------------------------------------

  describe("recordRequest", () => {
    it("increments counter with correct labels for tools/call", () => {
      recordRequest("tools/call", "blob-read");

      expect(mockCounterAdd).toHaveBeenCalledTimes(1);
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        method: "tools/call",
        tool: "blob-read",
      });
    });

    it("increments counter without tool label for non-tools/call methods", () => {
      recordRequest("tools/list");

      expect(mockCounterAdd).toHaveBeenCalledTimes(1);
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        method: "tools/list",
      });
    });

    it("increments counter for initialize method", () => {
      recordRequest("initialize");

      expect(mockCounterAdd).toHaveBeenCalledTimes(1);
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        method: "initialize",
      });
    });

    it('sanitises unknown tool names to "unknown"', () => {
      recordRequest("tools/call", "some_injected_value");

      expect(mockCounterAdd).toHaveBeenCalledTimes(1);
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        method: "tools/call",
        tool: "unknown",
      });
    });

    it("creates the meter lazily on first call", () => {
      recordRequest("initialize");

      expect(metrics.getMeter).toHaveBeenCalledWith("mcp-azure-storage");
      expect(mockCreateCounter).toHaveBeenCalledWith(
        "mcp.requests.total",
        expect.objectContaining({ description: expect.any(String) }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // recordError
  // -------------------------------------------------------------------------

  describe("recordError", () => {
    it("increments error counter with method label", () => {
      recordError("tools/call");

      expect(mockCounterAdd).toHaveBeenCalledTimes(1);
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        method: "tools/call",
      });
    });

    it("creates the mcp.requests.errors counter", () => {
      recordError("initialize");

      expect(mockCreateCounter).toHaveBeenCalledWith(
        "mcp.requests.errors",
        expect.objectContaining({ description: expect.any(String) }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // recordStaleSession
  // -------------------------------------------------------------------------

  describe("recordStaleSession", () => {
    it("increments the stale sessions counter", () => {
      recordStaleSession();

      expect(mockCounterAdd).toHaveBeenCalledTimes(1);
      expect(mockCounterAdd).toHaveBeenCalledWith(1);
    });

    it("creates the mcp.stale_sessions.received counter", () => {
      recordStaleSession();

      expect(mockCreateCounter).toHaveBeenCalledWith(
        "mcp.stale_sessions.received",
        expect.objectContaining({ description: expect.any(String) }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // recordServerStart
  // -------------------------------------------------------------------------

  describe("recordServerStart", () => {
    it("increments the server starts counter once", () => {
      recordServerStart();

      expect(mockCounterAdd).toHaveBeenCalledTimes(1);
      expect(mockCounterAdd).toHaveBeenCalledWith(1);
    });

    it("creates the mcp.server.starts counter", () => {
      recordServerStart();

      expect(mockCreateCounter).toHaveBeenCalledWith(
        "mcp.server.starts",
        expect.objectContaining({ description: expect.any(String) }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Graceful degradation
  // -------------------------------------------------------------------------

  describe("graceful degradation when OTel is not configured", () => {
    it("does not throw when counter.add throws", () => {
      mockCounterAdd.mockImplementation(() => {
        throw new Error("OTel not initialised");
      });

      expect(() => recordRequest("initialize")).not.toThrow();
      expect(() => recordError("tools/call")).not.toThrow();
      expect(() => recordStaleSession()).not.toThrow();
      expect(() => recordServerStart()).not.toThrow();
    });

    it("does not throw when getMeter throws", () => {
      _resetForTesting();
      vi.spyOn(metrics, "getMeter").mockImplementation(() => {
        throw new Error("No meter provider");
      });

      expect(() => recordRequest("initialize")).not.toThrow();
      expect(() => recordError("tools/call")).not.toThrow();
      expect(() => recordStaleSession()).not.toThrow();
      expect(() => recordServerStart()).not.toThrow();
    });

    it("does not throw when createCounter throws", () => {
      _resetForTesting();
      mockCreateCounter.mockImplementation(() => {
        throw new Error("Counter creation failed");
      });

      expect(() => recordRequest("tools/list")).not.toThrow();
      expect(() => recordError("initialize")).not.toThrow();
      expect(() => recordStaleSession()).not.toThrow();
      expect(() => recordServerStart()).not.toThrow();
    });
  });
});
