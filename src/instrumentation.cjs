/**
 * OpenTelemetry SDK bootstrap -- loaded via `node --require ./dist/instrumentation.cjs`.
 *
 * CommonJS (.cjs) because the project has "type": "module" and --require
 * cannot load ESM files.  This file is NOT compiled by tsc; it is copied
 * to dist/ during the build step.
 *
 * Activation guard: exits immediately (zero overhead) when
 * OTEL_EXPORTER_OTLP_ENDPOINT is not set.
 *
 * Telemetry level control via OTEL_TELEMETRY_LEVEL:
 *   off      -- same as not setting the endpoint
 *   basic    -- 10% trace sampling, 60s metrics, WARN+ logs (default)
 *   detailed -- 100% trace sampling, 15s metrics, INFO+ logs
 *   full     -- always_on sampler, 5s metrics, no log filter
 *
 * PII scrubbing (v1.4.0+, enhanced v1.4.1):
 *   Outbound HTTP and undici (fetch) spans have their URL attributes
 *   scrubbed. For Azure Storage endpoints (including Azurite via
 *   localhost, Docker service names, or custom domains from
 *   AZURE_*_SERVICE_URL): keep scheme + host + resource name only.
 *   For any other host: keep scheme + host only.
 *   Query strings are always removed.
 *
 *   When OTEL_SCRUB_HMAC_KEY is set, resource names are HMAC'd with
 *   that key for correlation without revealing names to the backend.
 *
 * @module instrumentation
 */

'use strict';

// -- Activation guard ---------------------------------------------------------

if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // No endpoint configured -- exit with zero overhead.
  return;
}

// -- Telemetry level ----------------------------------------------------------

var level = (process.env.OTEL_TELEMETRY_LEVEL || 'basic').toLowerCase();

if (level === 'off') {
  // Explicitly disabled -- exit with zero overhead.
  return;
}

// -- Level presets -------------------------------------------------------------

var LEVEL_PRESETS = {
  basic: {
    samplerArg: '0.1',
    metricsIntervalMs: 60000,
    logMinSeverity: 'WARN',
  },
  detailed: {
    samplerArg: '1.0',
    metricsIntervalMs: 15000,
    logMinSeverity: 'INFO',
  },
  full: {
    samplerArg: null, // uses always_on sampler
    metricsIntervalMs: 5000,
    logMinSeverity: null, // no filter
  },
};

var preset = LEVEL_PRESETS[level] || LEVEL_PRESETS.basic;

// Allow individual overrides via environment variables.
var samplerArg = process.env.OTEL_TRACES_SAMPLER_ARG || preset.samplerArg;
var metricsIntervalMs = parseInt(
  process.env.OTEL_METRICS_EXPORT_INTERVAL_MS || String(preset.metricsIntervalMs),
  10
);
var logMinSeverity = process.env.OTEL_LOG_MIN_SEVERITY || preset.logMinSeverity;

// -- Required for Azure Monitor -----------------------------------------------

if (!process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE) {
  process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = 'delta';
}

// -- Imports ------------------------------------------------------------------

var NodeSDK = require('@opentelemetry/sdk-node').NodeSDK;
var resourceFromAttributes = require('@opentelemetry/resources').resourceFromAttributes;
var ATTR_SERVICE_NAME = require('@opentelemetry/semantic-conventions').ATTR_SERVICE_NAME;
var OTLPTraceExporter = require('@opentelemetry/exporter-trace-otlp-http').OTLPTraceExporter;
var OTLPMetricExporter = require('@opentelemetry/exporter-metrics-otlp-http').OTLPMetricExporter;
var OTLPLogExporter = require('@opentelemetry/exporter-logs-otlp-http').OTLPLogExporter;
var PeriodicExportingMetricReader = require('@opentelemetry/sdk-metrics').PeriodicExportingMetricReader;
var BatchLogRecordProcessor = require('@opentelemetry/sdk-logs').BatchLogRecordProcessor;
var getNodeAutoInstrumentations = require('@opentelemetry/auto-instrumentations-node').getNodeAutoInstrumentations;
var sessionAttributes = require('./session-attributes.cjs').sessionAttributes;
var crypto = require('crypto');

// -- PII scrubbing for outbound HTTP and undici (fetch) spans -----------------
// Removes blob paths, file paths, entity keys, message IDs, and query strings
// from Azure Storage URLs in span attributes. Keeps only scheme + host +
// resource name (container/queue/table/share).
//
// For non-storage URLs (e.g. source URLs passed to blob-upload-from-url),
// only scheme + host is kept -- path, query, and fragment are removed.
//
// Controlled by OTEL_SCRUB_PII env var (default: true).
// When OTEL_SCRUB_HMAC_KEY is set, resource names are HMAC'd.

var REDACTED = '[redacted]';
var HMAC_PREFIX_LEN = 16;

function isPiiScrubEnabled() {
  var raw = (process.env.OTEL_SCRUB_PII || 'true').toLowerCase().trim();
  return raw !== 'false' && raw !== '0';
}

function getHmacKey() {
  var key = process.env.OTEL_SCRUB_HMAC_KEY;
  return key && key.length > 0 ? key : null;
}

function hmacValue(value, key) {
  return crypto
    .createHmac('sha256', key)
    .update(value)
    .digest('hex')
    .slice(0, HMAC_PREFIX_LEN);
}

/**
 * Identify Azure Storage service type from hostname.
 * Returns 'blob', 'queue', 'table', 'file', or null.
 */
function identifyService(hostname) {
  if (hostname.indexOf('.blob.core.windows.net') !== -1) return 'blob';
  if (hostname.indexOf('.queue.core.windows.net') !== -1) return 'queue';
  if (hostname.indexOf('.table.core.windows.net') !== -1) return 'table';
  if (hostname.indexOf('.file.core.windows.net') !== -1) return 'file';
  return null;
}

/**
 * Check whether hostname is a standard Azurite emulator address.
 * Covers localhost, 127.x.x.x, and [::1].
 */
function isAzuriteHost(hostname) {
  var h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '[::1]' ||
    h.indexOf('127.') === 0
  );
}

// -- Custom storage host discovery --------------------------------------------
// Build a set of additional hostnames that should be treated as storage
// endpoints. This covers:
//  - Azurite behind a Docker service name (e.g. http://azurite:10000/...)
//  - Custom domains configured via AZURE_*_SERVICE_URL

var customStorageHosts = (function buildCustomHosts() {
  var hosts = {};
  var envKeys = [
    'AZURE_BLOB_SERVICE_URL',
    'AZURE_QUEUE_SERVICE_URL',
    'AZURE_TABLE_SERVICE_URL',
    'AZURE_FILE_SERVICE_URL',
  ];
  for (var i = 0; i < envKeys.length; i++) {
    var raw = process.env[envKeys[i]];
    if (!raw) continue;
    try {
      var h = new URL(raw).hostname.toLowerCase();
      // Skip hosts already covered by identifyService or isAzuriteHost
      if (!identifyService(h) && !isAzuriteHost(h)) {
        hosts[h] = true;
      }
    } catch (e) { /* ignore invalid URLs */ }
  }
  return hosts;
})();

/**
 * Check whether a hostname is any known storage endpoint:
 * standard Azure Storage, Azurite (localhost/127.x/[::1]), or a custom
 * host from AZURE_*_SERVICE_URL (e.g. Docker service name).
 */
function isStorageHost(hostname) {
  if (identifyService(hostname)) return true;
  if (isAzuriteHost(hostname)) return true;
  if (customStorageHosts[hostname.toLowerCase()]) return true;
  return false;
}

/**
 * Strip table entity key parentheses from a path segment.
 * E.g. "TableName(PartitionKey='x',RowKey='y')" -> "TableName"
 */
function stripEntityKeys(segment) {
  var idx = segment.indexOf('(');
  if (idx > 0) return segment.slice(0, idx);
  return segment;
}

/**
 * Optionally HMAC a resource name based on OTEL_SCRUB_HMAC_KEY.
 */
function maybeHmacName(name) {
  var key = getHmacKey();
  return key ? hmacValue(name, key) : name;
}

/**
 * Scrub a URL for storage endpoints, keeping scheme + host + resource name.
 * Removes blob paths, file paths, entity keys, queries -- everything after
 * the resource name (container/queue/table/share).
 *
 * Supports all four Azure services, Azurite emulator URLs (localhost, 127.x,
 * [::1]), and custom storage hosts from AZURE_*_SERVICE_URL (e.g. Docker
 * service name like http://azurite:10000/...).
 *
 * Non-storage URLs are returned unchanged (use scrubOutboundUrl for full
 * outbound scrubbing).
 */
function scrubStorageUrl(url) {
  if (!url || !isPiiScrubEnabled()) return url;

  var parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return url;
  }

  var hostname = parsed.hostname;
  var serviceType = identifyService(hostname);
  var azuriteOrCustom = isAzuriteHost(hostname) ||
    (!!customStorageHosts[hostname.toLowerCase()]);

  if (!serviceType && !azuriteOrCustom) return url;

  var segments = parsed.pathname.split('/').filter(function (s) { return s.length > 0; });
  var prefix = parsed.protocol + '//' + parsed.host;

  if (azuriteOrCustom) {
    if (segments.length < 2) {
      return prefix + '/' + (segments[0] || '');
    }
    var accountName = segments[0];
    var resourceName = stripEntityKeys(segments[1]);
    return prefix + '/' + accountName + '/' + maybeHmacName(resourceName);
  }

  if (segments.length < 1) return prefix;
  var resName = stripEntityKeys(segments[0]);
  return prefix + '/' + maybeHmacName(resName);
}

/**
 * Scrub any outbound URL for span attributes.
 *
 * Storage endpoints (Azure, Azurite, custom hosts from AZURE_*_SERVICE_URL):
 *   scheme + host + resource name only (no blob path, no query).
 *
 * Non-storage endpoints:
 *   scheme + host only (no path, no query, no fragment).
 *   This prevents source URLs (e.g. from blob-upload-from-url) from
 *   leaking file names, SAS tokens, or query parameters into telemetry.
 */
function scrubOutboundUrl(url) {
  if (!url || !isPiiScrubEnabled()) return url;

  var parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return url;
  }

  var hostname = parsed.hostname;

  // Storage endpoint: delegate to scrubStorageUrl for resource-name retention
  if (isStorageHost(hostname)) {
    return scrubStorageUrl(url);
  }

  // Non-storage endpoint: scheme + host only
  return parsed.protocol + '//' + parsed.host;
}

/**
 * Scrub a URL path for storage endpoints, keeping only the resource name.
 * Used for url.path / http.target attributes.
 */
function scrubStoragePath(path, hostname) {
  if (!path) return path;

  var serviceType = identifyService(hostname || '');
  var azuriteOrCustom = isAzuriteHost(hostname || '') ||
    (!!customStorageHosts[(hostname || '').toLowerCase()]);

  if (!serviceType && !azuriteOrCustom) return path;

  var segments = path.split('/').filter(function (s) { return s.length > 0; });

  if (azuriteOrCustom) {
    if (segments.length < 2) return path;
    var accountName = segments[0];
    var resourceName = stripEntityKeys(segments[1]);
    return '/' + accountName + '/' + maybeHmacName(resourceName);
  }

  if (segments.length < 1) return path;
  var resName = stripEntityKeys(segments[0]);
  return '/' + maybeHmacName(resName);
}

/**
 * Scrub any outbound URL path for span attributes.
 *
 * Storage endpoints: keeps resource name (delegates to scrubStoragePath).
 * Non-storage endpoints: returns '/' (strip all path information).
 */
function scrubOutboundPath(path, hostname) {
  if (!path) return path;

  if (isStorageHost(hostname || '')) {
    return scrubStoragePath(path, hostname);
  }

  // Non-storage: strip the entire path
  return '/';
}

/**
 * Extract hostname from a URL string. Returns empty string on parse failure.
 */
function extractHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

/**
 * Scrub URL attributes on any span (HTTP or undici).
 *
 * @param {object} span - An OTel Span with setAttribute/attributes.
 * @param {boolean} outbound - If true, non-storage URLs are also scrubbed
 *   to scheme+host only. If false, only storage URLs are scrubbed (backward
 *   compatible behaviour for incoming HTTP spans).
 */
function scrubSpanUrlAttributes(span, outbound) {
  if (!isPiiScrubEnabled()) return;

  var hostname = '';
  var fullUrlAttrs = ['url.full', 'http.url'];
  var pathAttrs = ['url.path', 'http.target'];
  var queryAttr = 'url.query';
  var scrubUrlFn = outbound ? scrubOutboundUrl : scrubStorageUrl;
  var scrubPathFn = outbound ? scrubOutboundPath : scrubStoragePath;

  try {
    var attrs = span.attributes;
    if (!attrs) return;

    // First pass: scrub full URLs and extract hostname
    for (var i = 0; i < fullUrlAttrs.length; i++) {
      var attr = fullUrlAttrs[i];
      if (typeof attrs[attr] === 'string') {
        if (!hostname) {
          hostname = extractHostname(attrs[attr]);
        }
        var scrubbed = scrubUrlFn(attrs[attr]);
        if (scrubbed !== attrs[attr]) {
          span.setAttribute(attr, scrubbed);
        }
      }
    }

    // Second pass: scrub path attributes
    if (hostname) {
      for (var j = 0; j < pathAttrs.length; j++) {
        var pAttr = pathAttrs[j];
        if (typeof attrs[pAttr] === 'string') {
          var scrubbedPath = scrubPathFn(attrs[pAttr], hostname);
          if (scrubbedPath !== attrs[pAttr]) {
            span.setAttribute(pAttr, scrubbedPath);
          }
        }
      }
    }

    // Remove query string for storage URLs; for outbound non-storage,
    // the full URL is already stripped to scheme+host (no query possible).
    if (hostname && isStorageHost(hostname)) {
      if (typeof attrs[queryAttr] === 'string' && attrs[queryAttr].length > 0) {
        span.setAttribute(queryAttr, '');
      }
    }
    // For outbound non-storage spans, also strip query if present
    if (outbound && hostname && !isStorageHost(hostname)) {
      if (typeof attrs[queryAttr] === 'string' && attrs[queryAttr].length > 0) {
        span.setAttribute(queryAttr, '');
      }
    }
  } catch (e) {
    // Swallow -- never break instrumentation for scrubbing errors.
  }
}

// -- Severity number mapping for log filtering --------------------------------

var SEVERITY_MAP = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

var minSeverityNumber = logMinSeverity ? (SEVERITY_MAP[logMinSeverity.toUpperCase()] || 0) : 0;

// -- Exporters ----------------------------------------------------------------

var endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

var traceExporter = new OTLPTraceExporter({ url: endpoint + '/v1/traces' });
var metricExporter = new OTLPMetricExporter({ url: endpoint + '/v1/metrics' });
var logExporter = new OTLPLogExporter({ url: endpoint + '/v1/logs' });

// -- Metric reader ------------------------------------------------------------

var metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: metricsIntervalMs,
});

// -- Log processor ------------------------------------------------------------
// CRITICAL: BatchLogRecordProcessor takes an OPTIONS OBJECT, not positional args.

var logRecordProcessor = new BatchLogRecordProcessor({ exporter: logExporter });

// -- Auto-instrumentations ----------------------------------------------------

var instrumentations = getNodeAutoInstrumentations({
  // fs instrumentation is too noisy -- disable it.
  '@opentelemetry/instrumentation-fs': { enabled: false },
  // PII scrubbing for outbound HTTP spans (http/https modules).
  // Storage URLs: scheme + host + resource name only.
  // Non-storage URLs handled by incoming/outgoing distinction.
  // Incoming spans get session attributes attached.
  '@opentelemetry/instrumentation-http': {
    startIncomingSpanHook: function (request) {
      return sessionAttributes(request);
    },
    applyCustomAttributesOnSpan: function (span) {
      // HTTP instrumentation fires for both incoming and outgoing spans.
      // Use outbound=true for all -- incoming /mcp, /upload, /health paths
      // are not storage URLs so scrubStorageUrl returns them unchanged,
      // and scrubOutboundUrl also returns scheme+host for non-storage
      // (which is fine -- incoming spans have the server's own host).
      scrubSpanUrlAttributes(span, true);
    },
  },
  // PII scrubbing for undici (Node.js fetch) spans.
  // These are generated by the undici instrumentation when fetch() is
  // called (e.g. blob-upload-from-url). Without this hook, source URLs
  // including SAS tokens and file names leak into telemetry.
  '@opentelemetry/instrumentation-undici': {
    startSpanHook: function () {
      // No extra attributes needed on span start.
      return {};
    },
    responseHook: function (span) {
      scrubSpanUrlAttributes(span, true);
    },
  },
});

// -- Sampler configuration ----------------------------------------------------
// Set via OTel standard env vars so the SDK picks them up automatically.

if (level === 'full') {
  // Always-on sampler for full telemetry.
  if (!process.env.OTEL_TRACES_SAMPLER) {
    process.env.OTEL_TRACES_SAMPLER = 'always_on';
  }
} else {
  // Probability-based sampling for basic/detailed.
  if (!process.env.OTEL_TRACES_SAMPLER) {
    process.env.OTEL_TRACES_SAMPLER = 'parentbased_traceidratio';
  }
  if (!process.env.OTEL_TRACES_SAMPLER_ARG) {
    process.env.OTEL_TRACES_SAMPLER_ARG = samplerArg;
  }
}

// -- Resource -----------------------------------------------------------------

var serviceName = process.env.OTEL_SERVICE_NAME || 'mcp-azure-storage';
var replicaName = process.env.CONTAINER_APP_REPLICA_NAME || 'local';

var resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: serviceName,
  'container_app.replica.name': replicaName,
});

// -- SDK initialisation -------------------------------------------------------

var sdk = new NodeSDK({
  resource: resource,
  traceExporter: traceExporter,
  metricReader: metricReader,
  logRecordProcessor: logRecordProcessor,
  instrumentations: instrumentations,
});

sdk.start();

// -- Graceful shutdown --------------------------------------------------------

process.on('SIGTERM', function () {
  sdk
    .shutdown()
    .then(function () {
      // Flushed successfully.
    })
    .catch(function (err) {
      console.error('OTel SDK shutdown error:', err);
    })
    .finally(function () {
      process.exit(0);
    });
});
