# Stage 1: Download validator (can be cached separately)
FROM alpine:latest AS validator-downloader
RUN apk add --no-cache curl
WORKDIR /download
RUN curl -L -o validator.jar https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar

# Stage 2: Vocabularies are copied from the build context (git submodule)

# Stage 3: Install dependencies (better layer caching)
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lockb* ./
COPY server/package.json server/bun.lockb* ./server/
RUN bun install --frozen-lockfile && \
    cd server && bun install --frozen-lockfile

# Stage 4: Build application and load data
FROM oven/bun:1-alpine AS builder
RUN apk add --no-cache sqlite openjdk17-jre-headless
WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules

# Copy package files (needed for scripts)
COPY package.json bun.lockb* ./
COPY server/package.json server/bun.lockb* ./server/

# Copy source code
COPY src ./src
COPY bunfig.toml ./
COPY tailwind.config.js ./
COPY server/src ./server/src
COPY server/scripts ./server/scripts
COPY server/tests ./server/tests
COPY server/bunfig.toml ./server/
COPY server/tsconfig.json ./server/
COPY server/README.md ./server/
COPY index.html ./
COPY viewer.html ./
COPY public ./public
COPY examples ./examples
COPY tsconfig.json ./
COPY scripts ./scripts

# Copy validator from download stage
COPY --from=validator-downloader /download/validator.jar ./server/validator.jar

# Copy vocabularies from the build context (git submodule)
COPY server/large-vocabularies ./server/large-vocabularies
RUN cd server && \
    mkdir -p db && \
    bun run scripts/load-terminology.ts && \
    rm -rf large-vocabularies

# Optimize database
RUN sqlite3 server/db/terminology.sqlite "VACUUM;" && \
    sqlite3 server/db/terminology.sqlite "PRAGMA optimize;" && \
    sqlite3 server/db/terminology.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"

# Runtime stage - smaller image
FROM oven/bun:1-alpine

# Install runtime dependencies
RUN apk add --no-cache \
    openjdk17-jre-headless \
    tini

WORKDIR /app

# Copy built application from builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/bun.lockb* ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/index.html ./
COPY --from=builder /app/viewer.html ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/examples ./examples
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./

# Copy server with all setup complete
COPY --from=builder /app/server ./server

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3500
ENV VALIDATOR_HEAP=4g
ENV TERMINOLOGY_DB_PATH=/app/server/db/terminology.sqlite
ENV VALIDATOR_JAR=/app/server/validator.jar

# Expose ports
EXPOSE 3500

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3500/health || exit 1

# Use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Start the server
CMD ["bun", "run", "src/server.ts"]
