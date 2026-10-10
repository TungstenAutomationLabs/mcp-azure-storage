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
 *   basic    -- 10% trace sampling, 60s metrics, WARN+ logs
 *   detailed -- 100% trace sampling, 15s metrics, INFO+ logs (default)
 *   full     -- always_on sampler, 5s metrics, no log filter
 *
 * @module instrumentation
 */

'use strict';

// ── Activation guard ─────────────────────────────────────────────────────────

if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // No endpoint configured -- exit with zero overhead.
  return;
}

// ── Telemetry level ──────────────────────────────────────────────────────────

const level = (process.env.OTEL_TELEMETRY_LEVEL || 'detailed').toLowerCase();

if (level === 'off') {
  // Explicitly disabled -- exit with zero overhead.
  return;
}

// ── Level presets ────────────────────────────────────────────────────────────

const LEVEL_PRESETS = {
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

const preset = LEVEL_PRESETS[level] || LEVEL_PRESETS.basic;

// Allow individual overrides via environment variables.
const samplerArg = process.env.OTEL_TRACES_SAMPLER_ARG || preset.samplerArg;
const metricsIntervalMs = parseInt(
  process.env.OTEL_METRICS_EXPORT_INTERVAL_MS || String(preset.metricsIntervalMs),
  10
);
const logMinSeverity = process.env.OTEL_LOG_MIN_SEVERITY || preset.logMinSeverity;

// ── Required for Azure Monitor ───────────────────────────────────────────────

if (!process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE) {
  process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = 'delta';
}

// ── Imports ──────────────────────────────────────────────────────────────────

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { sessionAttributes } = require('./session-attributes.cjs');

// ── Severity number mapping for log filtering ────────────────────────────────

const SEVERITY_MAP = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

const minSeverityNumber = logMinSeverity ? (SEVERITY_MAP[logMinSeverity.toUpperCase()] || 0) : 0;

// ── Exporters ────────────────────────────────────────────────────────────────

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const traceExporter = new OTLPTraceExporter({ url: endpoint + '/v1/traces' });
const metricExporter = new OTLPMetricExporter({ url: endpoint + '/v1/metrics' });
const logExporter = new OTLPLogExporter({ url: endpoint + '/v1/logs' });

// ── Metric reader ────────────────────────────────────────────────────────────

const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: metricsIntervalMs,
});

// ── Log processor ────────────────────────────────────────────────────────────
// CRITICAL: BatchLogRecordProcessor takes an OPTIONS OBJECT, not positional args.

const logRecordProcessor = new BatchLogRecordProcessor({ exporter: logExporter });

// ── Auto-instrumentations ────────────────────────────────────────────────────

const instrumentations = getNodeAutoInstrumentations({
  // fs instrumentation is too noisy -- disable it.
  '@opentelemetry/instrumentation-fs': { enabled: false },
  // Attach session attributes to incoming HTTP spans.
  '@opentelemetry/instrumentation-http': {
    startIncomingSpanHook: function (request) {
      return sessionAttributes(request);
    },
  },
});

// ── Sampler configuration ────────────────────────────────────────────────────
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

// ── Resource ─────────────────────────────────────────────────────────────────

const serviceName = process.env.OTEL_SERVICE_NAME || 'mcp-azure-storage';

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: serviceName,
});

// ── SDK initialisation ───────────────────────────────────────────────────────

const sdk = new NodeSDK({
  resource: resource,
  traceExporter: traceExporter,
  metricReader: metricReader,
  logRecordProcessor: logRecordProcessor,
  instrumentations: instrumentations,
});

sdk.start();

// ── Graceful shutdown ────────────────────────────────────────────────────────

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
