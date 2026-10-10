/**
 * Unit tests for src/session-attributes.cjs
 *
 * Validates header extraction, array handling, length cap,
 * absent/empty/non-string edge cases, and whitespace trimming.
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  sessionAttributes,
  SESSION_ID_HEADER,
  ATTR_SESSION_ID,
  MAX_SESSION_ID_LENGTH,
} = require("../src/session-attributes.cjs");

describe("sessionAttributes", () => {
  it("returns session.id for a valid header", () => {
    const request = {
      headers: { [SESSION_ID_HEADER]: "abc123" },
    };
    expect(sessionAttributes(request)).toEqual({
      [ATTR_SESSION_ID]: "abc123",
    });
  });

  it("takes the first value when header is an array (repeated headers)", () => {
    const request = {
      headers: { [SESSION_ID_HEADER]: ["first-id", "second-id"] },
    };
    expect(sessionAttributes(request)).toEqual({
      [ATTR_SESSION_ID]: "first-id",
    });
  });

  it("returns empty object for strings exceeding MAX_SESSION_ID_LENGTH", () => {
    const longId = "x".repeat(MAX_SESSION_ID_LENGTH + 1);
    const request = {
      headers: { [SESSION_ID_HEADER]: longId },
    };
    expect(sessionAttributes(request)).toEqual({});
  });

  it("accepts strings exactly at MAX_SESSION_ID_LENGTH", () => {
    const exactId = "y".repeat(MAX_SESSION_ID_LENGTH);
    const request = {
      headers: { [SESSION_ID_HEADER]: exactId },
    };
    expect(sessionAttributes(request)).toEqual({
      [ATTR_SESSION_ID]: exactId,
    });
  });

  it("returns empty object when header is absent", () => {
    const request = { headers: {} };
    expect(sessionAttributes(request)).toEqual({});
  });

  it("returns empty object for an empty string header", () => {
    const request = {
      headers: { [SESSION_ID_HEADER]: "" },
    };
    expect(sessionAttributes(request)).toEqual({});
  });

  it("returns empty object for a non-string header value", () => {
    const request = {
      headers: { [SESSION_ID_HEADER]: 12345 },
    };
    expect(sessionAttributes(request)).toEqual({});
  });

  it("trims leading and trailing whitespace", () => {
    const request = {
      headers: { [SESSION_ID_HEADER]: "  trimmed-id  " },
    };
    expect(sessionAttributes(request)).toEqual({
      [ATTR_SESSION_ID]: "trimmed-id",
    });
  });

  it("returns empty object when trimmed value is empty (whitespace-only)", () => {
    const request = {
      headers: { [SESSION_ID_HEADER]: "   " },
    };
    expect(sessionAttributes(request)).toEqual({});
  });

  it("returns empty object when request is null", () => {
    expect(sessionAttributes(null)).toEqual({});
  });

  it("returns empty object when request has no headers property", () => {
    expect(sessionAttributes({})).toEqual({});
  });

  it("returns empty object when headers is null", () => {
    expect(sessionAttributes({ headers: null })).toEqual({});
  });
});

describe("exported constants", () => {
  it("SESSION_ID_HEADER is mcp-session-id", () => {
    expect(SESSION_ID_HEADER).toBe("mcp-session-id");
  });

  it("ATTR_SESSION_ID is session.id", () => {
    expect(ATTR_SESSION_ID).toBe("session.id");
  });

  it("MAX_SESSION_ID_LENGTH is 200", () => {
    expect(MAX_SESSION_ID_LENGTH).toBe(200);
  });
});
