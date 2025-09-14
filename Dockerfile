# Stage 1: Build vocabulary database (early for better caching)
FROM oven/bun:1-alpine AS vocab-builder
RUN apk add --no-cache sqlite
WORKDIR /app/server

# Copy only what's needed for vocabulary building
COPY server/package.json server/bun.lockb* ./
RUN bun install --frozen-lockfile

COPY server/scripts ./scripts
COPY server/tsconfig.json ./

# Copy vocabularies
COPY server/large-vocabularies ./large-vocabularies

# Build the database
RUN mkdir -p db && \
    bun run scripts/load-terminology.ts && \
    rm -rf large-vocabularies && \
    sqlite3 db/terminology.sqlite "VACUUM;" && \
    sqlite3 db/terminology.sqlite "PRAGMA optimize;" && \
    sqlite3 db/terminology.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"

# Runtime stage
FROM oven/bun:1-alpine

# Install runtime dependencies
RUN apk add --no-cache \
    openjdk17-jre-headless \
    tini \
    curl

WORKDIR /app

# Copy package files first (for better caching)
COPY package.json bun.lockb* ./
COPY server/package.json server/bun.lockb* ./server/

# Install dependencies (this layer caches if package files don't change)
RUN bun install --frozen-lockfile && \
    cd server && bun install --frozen-lockfile

# Copy application source and configs
COPY src ./src
COPY index.html ./
COPY viewer.html ./
COPY public ./public
COPY examples ./examples
COPY scripts ./scripts
COPY tsconfig.json ./

# Copy server source
COPY server/src ./server/src
COPY server/tsconfig.json ./server/
COPY server/README.md ./server/

# Copy pre-built vocabulary database
COPY --from=vocab-builder /app/server/db ./server/db

# Download validator JAR
RUN curl -L -o ./server/validator.jar https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar

# Copy bunfig.toml files directly (needed for runtime)
COPY bunfig.toml ./
COPY server/bunfig.toml ./server/

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
