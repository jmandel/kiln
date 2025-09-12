# Docker Setup for FHIR Synthesizer

This project includes Docker configurations for containerized deployment.

## Quick Start

### Using Docker Compose (Recommended)
```bash
docker-compose up
```
The application will be available at `http://localhost:3500`

### Manual Docker Build

#### Slim Build (Fast, no pre-loaded vocabularies)
```bash
docker build -f Dockerfile.slim -t fhir-synthesizer:slim .
docker run -p 3500:3500 fhir-synthesizer:slim
```

#### Full Build (Pre-loaded vocabularies, optimized database)
```bash
docker build -t fhir-synthesizer:latest .
docker run -p 3500:3500 fhir-synthesizer:latest
```

## Build Details

### Dockerfile (Production)
- Multi-stage build for smaller final image
- Downloads and pre-loads all vocabularies during build
- Runs database vacuum and optimization
- Includes validator JAR
- Final image size: ~500MB (without vocabularies in build cache)

### Dockerfile.slim (Development/Testing)
- Single-stage build
- Downloads validator JAR only
- No vocabulary pre-loading (faster build)
- Suitable for development and testing

## Environment Variables

- `PORT`: Server port (default: 3500)
- `VALIDATOR_HEAP`: Java heap size for validator (default: 4g)
- `TERMINOLOGY_DB_PATH`: Path to terminology database (default: /app/server/db/terminology.sqlite)
- `VALIDATOR_JAR`: Path to validator JAR (default: /app/server/validator.jar)

## Health Check

The container includes a health check endpoint at `/health` that monitors:
- Terminology service availability
- Validator service readiness

## Volumes

Optional volume mounts:
- `/app/server/db`: Mount to preserve database between container rebuilds

## Build Time

- Slim build: ~2 minutes
- Full build: ~15-20 minutes (includes vocabulary download and processing)

## Resource Requirements

- Minimum RAM: 4GB
- Recommended RAM: 8GB
- Disk space: ~2GB for full build with vocabularies