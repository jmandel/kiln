# FHIR Server

A unified FHIR terminology search and validation server built with Bun.

## Features

- **Terminology Search** (`/tx/*` endpoints)
  - Full-text search across LOINC, SNOMED CT, RxNorm, and other code systems
  - Batch search support
  - Code existence checking
  - Fuzzy matching and suggestions

- **FHIR Validation** (`/validate/*` endpoints)
  - Validate FHIR resources against R4 specification
  - Batch validation support
  - Profile-based validation

## Quick Start

```bash
# 1. Install dependencies and setup
bun run setup

# 2. Load terminology database
bun run load-terminology

# 3. Start the server
bun run start
```

The server will run on http://localhost:3500 by default.

## Setup Details

The `setup` script will:

- Download the FHIR validator JAR from GitHub
- Set up the large-vocabularies repository as a git submodule
- Create necessary directories

## API Endpoints

### Terminology Search

- `POST /tx/search` - Search for terminology
  - Request: `{ "queries": ["diabetes", "hypertension"], "systems": ["snomed"], "limit": 20 }`
  - Returns: `{ "results": [{ "query": "diabetes", "hits": [...], "count": N }, ...] }`
- `POST /tx/codes/exists` - Check if codes exist
- `GET /tx/capabilities` - Get supported code systems

### Validation

- `POST /validate` - Validate a single FHIR resource
- `POST /validate/batch` - Validate multiple resources

### General

- `GET /health` - Health check endpoint

## Environment Variables

- `PORT` - Server port (default: 3500)
- `VALIDATOR_HEAP` - Java heap size for validator (default: 4g)

## Testing

```bash
# Run all tests
bun test

# Run specific test suite
bun test:terminology
bun test:validator
```

Tests generate detailed reports in `tests/*-report.json` for manual inspection.

## Database Schema

The terminology database uses a normalized schema:

- `concepts` - Core concept information (system, code, display)
- `designations` - All labels/designations for concepts (searchable via FTS5)
- `code_systems` - Metadata about loaded code systems

This design allows searching across all designations holistically, not just primary display names.

## Dependencies

- **Bun** - JavaScript runtime and package manager
- **Java 11+** - Required for FHIR validator
- **Git** - For managing the large-vocabularies submodule

## Project Structure

```
server/
├── src/
│   ├── server.ts               # Main server entrypoint
│   └── services/
│       ├── terminology.ts      # Terminology search service
│       └── validator.ts        # FHIR validation service
├── scripts/
│   ├── load-terminology.ts     # Database loader
│   └── setup.ts                # Setup script for dependencies
├── tests/
│   ├── utils/test-server.ts    # Test server launcher
│   ├── terminology.test.ts
│   └── validator.test.ts
├── db/                         # Database directory (created by setup)
│   └── terminology.sqlite      # Terminology database
├── large-vocabularies/         # Git submodule with FHIR vocabularies
├── package.json                # Scripts and dependencies
├── bunfig.toml                 # Bun test config
├── tsconfig.json               # TypeScript config
├── README.md                   # This file
├── .gitignore                  # Git ignore rules
└── validator.jar               # FHIR validator (downloaded by setup)
```

## License

See parent repository for license information.
