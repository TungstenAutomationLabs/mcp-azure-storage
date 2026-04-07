# =============================================================================
# Multi-stage Dockerfile for the MCP Azure Storage server.
#
# Stage 1 ("builder") — installs ALL dependencies (including devDependencies
# like TypeScript) and compiles src/**/*.ts → dist/**/*.js.
#
# Stage 2 ("runtime") — starts from a clean Alpine image, copies only the
# compiled JavaScript and production dependencies, resulting in a smaller,
# more secure image with no compiler toolchain or dev packages.
#
# Build:   docker build -t mcp-azure-storage .
# Run:     docker run -p 3000:3000 --env-file .env mcp-azure-storage
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Build — compile TypeScript to JavaScript
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Copy manifests first so Docker caches the npm-install layer when only
# source files change (not dependencies).
COPY package*.json ./
RUN npm ci

# Copy TypeScript config and source, then compile.
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# ---------------------------------------------------------------------------
# Stage 2: Runtime — minimal production image
# ---------------------------------------------------------------------------
FROM node:20-alpine

# Create a non-root user/group for least-privilege execution.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app

# Copy compiled output from the builder stage.
COPY --from=builder /app/dist ./dist

# Install only production dependencies (no devDependencies) and clear cache
# to keep the layer small.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Ensure the non-root user owns all application files.
RUN chown -R appuser:appgroup /app
USER appuser

# Set Node.js to production mode (disables dev warnings, enables perf opts).
ENV NODE_ENV=production

# The Express server listens on this port (configurable via PORT env var).
ENV PORT=3000
EXPOSE 3000

# Start the MCP server. No shell form — exec form avoids PID 1 signal issues.
CMD ["node", "dist/server.js"]
