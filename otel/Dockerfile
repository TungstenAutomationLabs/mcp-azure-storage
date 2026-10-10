# OTel Collector sidecar with Azure Monitor configuration baked in.
# Built and pushed to the same ACR as the MCP server image.
#
# The config is embedded rather than volume-mounted because Azure
# Container Apps sidecar containers have limited volume mount support.
#
# Pinned to a specific version tag for reproducible builds.
# The default config path for the contrib image is
# /etc/otelcol-contrib/config.yaml.
#
# CRITICAL (trap 2): The APPLICATIONINSIGHTS_CONNECTION_STRING env var
# must be set to a non-empty value at container startup.  An empty
# connection string kills the entire collector at config-decode time.
# Set a placeholder default in the ACA environment definition:
#   InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://localhost/
#
# Required environment variables (set in ACA / docker-compose):
#   APPLICATIONINSIGHTS_CONNECTION_STRING  -- App Insights connection string
#   OTEL_LOG_MIN_SEVERITY                  -- Numeric severity threshold (default: 13 = WARN)
#   OTEL_DEPLOYMENT_ENV                    -- deployment.environment resource attribute

FROM otel/opentelemetry-collector-contrib:0.127.0

COPY otel-collector-config.azure.yaml /etc/otelcol-contrib/config.yaml
