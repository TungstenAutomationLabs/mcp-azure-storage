/**
 * Tests for describeEndpoint: configured service URLs are shown without SAS
 * tokens, credentials or fragments (config.ts HTTP warning, store-info).
 */

import { describeEndpoint } from "../../src/utils/safe-url.js";

const SECRET = "synthSasSig9Kq";

describe("describeEndpoint", () => {
  it("keeps scheme, host, port and path", () => {
    expect(describeEndpoint("http://127.0.0.1:10000/devstoreaccount1")).toBe("http://127.0.0.1:10000/devstoreaccount1");
    expect(describeEndpoint("https://acct.blob.core.windows.net/")).toBe("https://acct.blob.core.windows.net");
  });

  it("drops the query, fragment and user-info", () => {
    const out = describeEndpoint(`https://user:${SECRET}@acct.blob.core.windows.net/c?sv=1&sig=${SECRET}#${SECRET}`);
    expect(out).toBe("https://acct.blob.core.windows.net/c");
    expect(out).not.toContain(SECRET);
  });

  it("does not echo text that is not a URL", () => {
    expect(describeEndpoint(`AccountKey=${SECRET}`)).toBe("[invalid URL]");
  });
});
