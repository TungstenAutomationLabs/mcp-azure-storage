/**
 * Regression tests for Veracode flaw 382 (CWE-798, server.ts getRateLimitKey)
 * and the throttling gap found beside it: the rate-limit identity holds no
 * material derived from the credential, and a request that does not present
 * the configured credential is always counted against its client address.
 */

import { AUTHENTICATED_CLIENT_BUCKET, getRateLimitKey } from "../../src/utils/rate-limit-key.js";
import { credentialMatches, presentedCredential } from "../../src/utils/credentials.js";

const CONFIGURED = "synthetic-configured-key-0123456789";

function req(headers: Record<string, string> = {}, ip: string | undefined = "203.0.113.7") {
  return { headers, ip } as Parameters<typeof getRateLimitKey>[0];
}

describe("presentedCredential", () => {
  it("reads X-API-Key first, then a Bearer token, and nothing else", () => {
    expect(presentedCredential({ "x-api-key": "a", authorization: "Bearer b" })).toBe("a");
    expect(presentedCredential({ authorization: "Bearer b" })).toBe("b");
    expect(presentedCredential({ authorization: "bearer   b c" })).toBe("b c");
    expect(presentedCredential({ authorization: "Basic dXNlcjpwYXNz" })).toBeUndefined();
    expect(presentedCredential({ "x-api-key": "" })).toBeUndefined();
    expect(presentedCredential({})).toBeUndefined();
  });
});

describe("credentialMatches", () => {
  it("matches only the identical credential", () => {
    expect(credentialMatches(CONFIGURED, CONFIGURED)).toBe(true);
    expect(credentialMatches(CONFIGURED, `${CONFIGURED}x`)).toBe(false);
    expect(credentialMatches(CONFIGURED, "")).toBe(false);
  });

  it("does not throw for a same-length value with multi-byte characters", () => {
    // 4 characters each, but "abcé" is 5 bytes in UTF-8. The previous
    // string-length check passed these to crypto.timingSafeEqual, which throws.
    expect(() => credentialMatches("abcd", "abcé")).not.toThrow();
    expect(credentialMatches("abcd", "abcé")).toBe(false);
  });
});

describe("getRateLimitKey", () => {
  it("puts the configured credential in the authenticated bucket, by header or Bearer", () => {
    expect(getRateLimitKey(req({ "x-api-key": CONFIGURED }), CONFIGURED))
      .toEqual({ key: AUTHENTICATED_CLIENT_BUCKET, isApiKey: true });
    expect(getRateLimitKey(req({ authorization: `Bearer ${CONFIGURED}` }), CONFIGURED))
      .toEqual({ key: AUTHENTICATED_CLIENT_BUCKET, isApiKey: true });
  });

  it("holds no material derived from the credential", () => {
    const { key } = getRateLimitKey(req({ "x-api-key": CONFIGURED }), CONFIGURED);
    expect(key).not.toContain(CONFIGURED);
    expect(key).not.toMatch(/[a-f0-9]{32,}/);
    expect(key).toBe(getRateLimitKey(req({ "x-api-key": CONFIGURED }, "198.51.100.1"), CONFIGURED).key);
  });

  it("counts missing, wrong and malformed credentials against the client address", () => {
    for (const headers of [{}, { "x-api-key": "wrong" }, { authorization: "Bearer wrong" },
      { authorization: "Basic abc" }, { "x-api-key": "abcé" }] as Record<string, string>[]) {
      expect(getRateLimitKey(req(headers), CONFIGURED)).toEqual({ key: "ip:203.0.113.7", isApiKey: false });
    }
  });

  it("does not let a caller open new budgets by rotating keys", () => {
    const keys = new Set(Array.from({ length: 50 }, (_, i) =>
      getRateLimitKey(req({ "x-api-key": `guess-${i}` }), CONFIGURED).key));
    expect(keys).toEqual(new Set(["ip:203.0.113.7"]));
  });

  it("treats every credential as unauthenticated when MCP_API_KEY is unset", () => {
    expect(getRateLimitKey(req({ "x-api-key": "anything" }), undefined).key).toBe("ip:203.0.113.7");
    expect(getRateLimitKey(req({ "x-api-key": "anything" }), "").key).toBe("ip:203.0.113.7");
    const keys = new Set(Array.from({ length: 20 }, (_, i) =>
      getRateLimitKey(req({ "x-api-key": `k${i}` }), undefined).key));
    expect(keys.size).toBe(1);
  });

  it("puts requests with no resolvable address in one shared bucket", () => {
    const noAddress = { headers: {}, ip: undefined } as Parameters<typeof getRateLimitKey>[0];
    expect(getRateLimitKey(noAddress, CONFIGURED).key).toBe("ip:unknown");
    expect(getRateLimitKey(req({}, ""), CONFIGURED).key).toBe("ip:unknown");
  });

  it("groups IPv6 addresses by /56 so rotating within an allocation does not help", () => {
    const a = getRateLimitKey(req({}, "2001:db8:1:2:3:4:5:6"), CONFIGURED).key;
    const b = getRateLimitKey(req({}, "2001:db8:1:2:ffff::1"), CONFIGURED).key;
    const c = getRateLimitKey(req({}, "2001:db8:2::1"), CONFIGURED).key;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("reads MCP_API_KEY at call time by default", () => {
    const saved = process.env.MCP_API_KEY;
    try {
      process.env.MCP_API_KEY = CONFIGURED;
      expect(getRateLimitKey(req({ "x-api-key": CONFIGURED })).isApiKey).toBe(true);
      process.env.MCP_API_KEY = "rotated-key";
      expect(getRateLimitKey(req({ "x-api-key": CONFIGURED })).isApiKey).toBe(false);
    } finally {
      process.env.MCP_API_KEY = saved;
    }
  });
});
