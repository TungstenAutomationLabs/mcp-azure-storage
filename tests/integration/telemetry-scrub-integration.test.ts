/**
 * Integration test: telemetry scrubbing at the export layer.
 *
 * Wires real OTel undici instrumentation to in-memory span exporters with
 * the same scrubbing hooks used in instrumentation.cjs. Performs real
 * fetch() operations against Azurite and asserts that no exported span
 * leaks blob paths, filenames, or query strings.
 *
 * Why fetch/undici? The v1.4.1 change specifically targets the undici
 * instrumentation path (Node's fetch is traced by undici). The
 * blob-upload-from-url tool calls fetch(sourceUrl) at line 775 of
 * src/tools/blob-tools.ts -- that's the exact code path under test.
 *
 * Requirements:
 *   1. Azurite running: docker compose -f docker-compose.azurite.yml up -d
 *   2. Environment: TEST_INTEGRATION=1
 *   3. Azurite env vars set (AZURE_BLOB_SERVICE_URL, etc.)
 *
 * Run: npm run test:integration
 *
 * @module tests/integration/telemetry-scrub-integration
 */

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  SimpleSpanProcessor,
  InMemorySpanExporter,
  ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import {
  scrubOutboundUrl,
  scrubUrlPath,
  isStorageHost,
} from "../../src/utils/pii-scrubber.js";

const SKIP = !process.env.TEST_INTEGRATION;

// Sensitive values that must NEVER appear in exported spans
const SECRET_BLOB_NAME = "confidential/report-2024-q4.pdf";
const SECRET_QUERY = "sv=2024-01-01&sig=fakeSasToken123";

// ---------------------------------------------------------------------------
// Replicate the scrubbing hook logic from instrumentation.cjs so we can
// wire it to in-memory exporters. This proves the hook *path*, not just
// the scrub *functions*.
// ---------------------------------------------------------------------------

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function scrubSpanUrlAttributes(span: any, outbound: boolean): void {
  const fullUrlAttrs = ["url.full", "http.url"];
  const pathAttrs = ["url.path", "http.target"];
  const queryAttr = "url.query";

  try {
    const attrs = span.attributes;
    if (!attrs) return;

    let hostname = "";

    for (const attr of fullUrlAttrs) {
      if (typeof attrs[attr] === "string") {
        if (!hostname) hostname = extractHostname(attrs[attr]);
        const scrubbed = scrubOutboundUrl(attrs[attr]);
        if (scrubbed !== attrs[attr]) {
          span.setAttribute(attr, scrubbed);
        }
      }
    }

    if (hostname) {
      for (const pAttr of pathAttrs) {
        if (typeof attrs[pAttr] === "string") {
          const scrubbedPath =
            outbound && !isStorageHost(hostname)
              ? "/"
              : scrubUrlPath(attrs[pAttr], hostname);
          if (scrubbedPath !== attrs[pAttr]) {
            span.setAttribute(pAttr, scrubbedPath);
          }
        }
      }
    }

    // Remove query string attribute for storage URLs
    if (
      hostname &&
      isStorageHost(hostname) &&
      typeof attrs[queryAttr] === "string" &&
      attrs[queryAttr].length > 0
    ) {
      span.setAttribute(queryAttr, "");
    }

    // For outbound non-storage spans, also strip query
    if (
      outbound &&
      hostname &&
      !isStorageHost(hostname) &&
      typeof attrs[queryAttr] === "string" &&
      attrs[queryAttr].length > 0
    ) {
      span.setAttribute(queryAttr, "");
    }
  } catch {
    // Never break instrumentation for scrubbing errors
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("telemetry scrubbing integration (Azurite)", () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let blobServiceClient: BlobServiceClient;
  const containerName = `test-scrub-${Date.now()}`;

  beforeAll(async () => {
    // -- 1. Set up in-memory OTel with undici instrumentation ----------------
    // We test the undici (fetch) path specifically because that's the
    // code path exercised by blob-upload-from-url -- the v1.4.1 fix target.

    exporter = new InMemorySpanExporter();

    const undiciInstr = new UndiciInstrumentation({
      startSpanHook: () => ({}),
      responseHook: (span: any) => {
        scrubSpanUrlAttributes(span, true);
      },
    });

    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();

    registerInstrumentations({
      tracerProvider: provider,
      instrumentations: [undiciInstr],
    });

    // -- 2. Set up Azurite blob client + test container ---------------------

    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME!;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY!;
    const url = process.env.AZURE_BLOB_SERVICE_URL!;

    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    blobServiceClient = new BlobServiceClient(url, credential);

    const containerClient =
      blobServiceClient.getContainerClient(containerName);
    await containerClient.createIfNotExists();

    // Upload a blob with a sensitive name (via SDK -- not traced here)
    const blockBlobClient =
      containerClient.getBlockBlobClient(SECRET_BLOB_NAME);
    await blockBlobClient.upload("secret content", 14);

    // Clear any spans generated during setup
    exporter.reset();
  });

  afterAll(async () => {
    // Clean up Azurite
    try {
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      for await (const blob of containerClient.listBlobsFlat()) {
        await containerClient.getBlockBlobClient(blob.name).delete();
      }
      await containerClient.deleteIfExists();
    } catch {
      /* best-effort */
    }

    // Tear down OTel
    await provider.shutdown();
  });

  /**
   * Collect all string attribute values from exported spans.
   */
  function allStringAttrs(spans: ReadableSpan[]): string[] {
    const values: string[] = [];
    for (const span of spans) {
      for (const [, value] of Object.entries(span.attributes)) {
        if (typeof value === "string") {
          values.push(value);
        }
      }
      // Also check span name
      values.push(span.name);
    }
    return values;
  }

  /**
   * Assert that none of the sensitive values appear in any exported
   * span attribute or span name.
   */
  function assertNoLeaks(
    spans: ReadableSpan[],
    sensitiveValues: string[],
  ): void {
    const all = allStringAttrs(spans);
    for (const text of all) {
      for (const sensitive of sensitiveValues) {
        expect(text).not.toContain(sensitive);
      }
    }
  }

  // ========================================================================
  // fetch() to Azurite storage URL -- blob path must be scrubbed
  // ========================================================================

  it("fetch() to Azurite blob URL does not leak blob path in spans", async () => {
    exporter.reset();

    // Simulate what blob-upload-from-url does: fetch a URL that contains
    // a sensitive blob path. The URL targets Azurite directly.
    const blobUrl =
      `${process.env.AZURE_BLOB_SERVICE_URL}/${containerName}/${SECRET_BLOB_NAME}`;

    try {
      const resp = await fetch(blobUrl);
      await resp.text();
    } catch {
      // Auth errors are expected -- we only need the span
    }

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);

    // The blob path segments must NOT appear in any span
    assertNoLeaks(spans, [
      "confidential",
      "report-2024-q4.pdf",
      SECRET_BLOB_NAME,
    ]);

    // But the container name SHOULD be preserved (it's the resource name)
    const all = allStringAttrs(spans);
    const hasContainerName = all.some((v) => v.includes(containerName));
    expect(hasContainerName).toBe(true);
  });

  // ========================================================================
  // fetch() with SAS query string -- query must be stripped
  // ========================================================================

  it("fetch() to Azurite blob URL with query does not leak SAS tokens", async () => {
    exporter.reset();

    const blobUrl =
      `${process.env.AZURE_BLOB_SERVICE_URL}/${containerName}/${SECRET_BLOB_NAME}?${SECRET_QUERY}`;

    try {
      const resp = await fetch(blobUrl);
      await resp.text();
    } catch {
      // Auth/connection errors are expected
    }

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);

    // No span should contain the SAS query parameters
    assertNoLeaks(spans, [
      "fakeSasToken123",
      SECRET_QUERY,
      "sig=",
    ]);
  });

  // ========================================================================
  // fetch() with deeply nested blob path -- all segments stripped
  // ========================================================================

  it("fetch() with deeply nested blob path strips all path segments", async () => {
    exporter.reset();

    const deepPath = "users/john-doe/uploads/2024/financials/secret-report.xlsx";
    const deepUrl =
      `${process.env.AZURE_BLOB_SERVICE_URL}/${containerName}/${deepPath}`;

    try {
      const resp = await fetch(deepUrl);
      await resp.text();
    } catch {
      // Expected -- blob may not exist and auth may fail
    }

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);

    // None of the deep path segments should appear
    assertNoLeaks(spans, [
      "john-doe",
      "financials",
      "secret-report.xlsx",
      deepPath,
    ]);
  });

  // ========================================================================
  // fetch() to existing blob -- verify download path is also scrubbed
  // ========================================================================

  it("fetch() download of existing blob scrubs path from spans", async () => {
    exporter.reset();

    // This blob was uploaded in beforeAll
    const downloadUrl =
      `${process.env.AZURE_BLOB_SERVICE_URL}/${containerName}/${SECRET_BLOB_NAME}`;

    try {
      const resp = await fetch(downloadUrl);
      // Consume body to ensure span completes
      await resp.arrayBuffer();
    } catch {
      // Expected
    }

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);

    assertNoLeaks(spans, [
      "confidential",
      "report-2024-q4.pdf",
    ]);
  });

  // ========================================================================
  // url.query attribute is empty on storage spans
  // ========================================================================

  it("url.query attribute is cleared on storage fetch spans", async () => {
    exporter.reset();

    const blobUrl =
      `${process.env.AZURE_BLOB_SERVICE_URL}/${containerName}/${SECRET_BLOB_NAME}?comp=block&sv=test-token`;

    try {
      const resp = await fetch(blobUrl);
      await resp.text();
    } catch {
      // Expected
    }

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    for (const span of spans) {
      const query = span.attributes["url.query"];
      if (typeof query === "string") {
        expect(query).toBe("");
      }
    }
  });
});
