# Kiln: Clinical Narrative From Raw Clay

## 1. Overview

Kiln is a browser-based clinical authoring tool that transforms free-text sketches into structured Markdown notes, with built-in LLM assistance for realism and integrated FHIR validation for interoperability. Designed for clinicians and developers, it emphasizes privacy (local-first, no server storage) while enabling rapid creation of high-quality, standards-compliant documents. Built with Bun.js and React, it runs entirely in the browser with optional server-side APIs for terminology and validation.

### Core Mental Model
Kiln treats note creation as a "kiln-firing" process: start with raw clay (a sketch like "52F with chest pain, onset 2 weeks ago"), shape it through iterative refinement (outline → sections → full note), and validate the final form (FHIR Bundle). The workflow is linear yet cyclical—LLM generates drafts, critiques for clinical accuracy (scoring 0-1), and refines until approval. Output is a self-contained FHIR document (Bundle with Composition + discrete resources like Condition, Observation), annotated for unresolved issues. No EHR integration; focus on exportable, valid artifacts.

```mermaid
flowchart TD
    A[Clinical Sketch] --> B[LLM: Outline + Briefs]
    B --> C[Section Drafts<br/>(Iterate: Draft → Critique → Approve)]
    C --> D[Assemble Full Note<br/>(Markdown with H2 sections)]
    D --> E[LLM: FHIR Composition Plan]
    E --> F[Generate Resources<br/>(e.g., Condition, Observation)]
    F --> G[Refine + Validate<br/>(Coding, Structure)]
    G --> H[FHIR Bundle<br/>(Document + Entries)]
    H --> I[Export/Validate]
```

### Use Cases
- **Rapid Drafting**: Turn a quick sketch into a polished SOAP note with AI-guided sections (e.g., HPI, Assessment, Plan).
- **FHIR Export**: Generate validated IPS-compliant Bundles for HIE, registries, or clinical systems.
- **Terminology Assistance**: Search LOINC/SNOMED/RxNorm during authoring; auto-refine codings via LLM + validation.
- **Education/Prototyping**: Explore FHIR modeling from narrative; test validation without full EHR setup.
- **Offline Authoring**: Works without internet (localStorage for notes, optional offline validator via Java).

### Non-Goals
- Persistent storage or multi-user collaboration (use localStorage or export to EHR).
- Full EHR features (e.g., no scheduling, messaging, or user auth).
- Real-time collaboration or server-side note processing (client-only for privacy).
- Support for pre-FHIR4 versions or non-IPS profiles (focus on R4/IPS).

## 2. Architecture

Kiln's architecture is client-centric, prioritizing privacy and offline capability. The browser handles core authoring and LLM interactions, while the optional server provides stateless utilities (search/validation). No note data is stored server-side—everything persists in localStorage or exported files. The system scales horizontally for APIs but remains lightweight for single-user workflows.

### Components

- **Client (Browser)**: A React 19 single-page application (SPA) built with Bun.js for bundling. Manages the note editor (Markdown rendering via marked), LLM API calls (e.g., to OpenAI or OpenRouter), and localStorage for configuration (API keys, FHIR endpoints, user preferences). Handles export to FHIR Bundles (JSON/Markdown) and offline mode (caches recent notes). No build tools like Webpack—uses Bun's native ESM bundling for fast iteration.
  
- **Server (Bun.ts)**: A minimal API server (port 3500) for terminology search and FHIR validation. Uses SQLite with FTS5 for fast full-text search across LOINC, SNOMED CT, and RxNorm (pre-loaded from NDJSON). FHIR validation runs HAPI FHIR validator as a Java subprocess (JDK 17+). No authentication or sessions; CORS allows all origins by default. Serves as a drop-in for production or dev; optional for offline use.

- **External Services**:
  - **LLM Provider**: Configurable via UI (e.g., OpenAI GPT-4o-mini, Anthropic Claude, or OpenRouter proxy). Handles narrative generation, critique, and FHIR mapping. Client manages auth (API keys in localStorage).
  - **FHIR Validator**: Points to a remote server (e.g., HAPI FHIR at `https://r4.ontoserver.csiro.au/fhir`) or runs locally via Java. Validates structure, profiles (IPS), and codings.
  - **Terminology Server**: Local SQLite for primary search (no network needed). Fallback to remote (e.g., HL7 Terminology Server) if configured. Supports SNOMED CT, LOINC, RxNorm, and FHIR built-ins.

Tech stack: Bun.js (runtime/server), React 19 (UI), Tailwind CSS (styling), SQLite (FTS5 for search), Java 17+ (validator). Total bundle ~500KB minified; no Node.js dependencies.

### Data Flow Mental Model
The client orchestrates the entire workflow: user inputs drive LLM calls, which generate/refine content locally. Server APIs are "fire-and-forget"—queries return immediately (search <50ms, validation <5s). No shared state or user sessions; all configuration and temporary data live in localStorage. FHIR output is a complete, self-contained Bundle (no external refs), making it portable for import into EHRs or registries. For high-load, scale the server horizontally (SQLite read replicas) while keeping the client static.

### Diagram

```mermaid
graph TB
    subgraph Client ["Browser Client (React/Bun)"]
        UI[Note Editor + Markdown]
        LLM[LLM Calls (OpenAI/OpenRouter)]
        LS[localStorage (Config + Notes)]
        UI --> LLM
        UI --> LS
        UI --> EXP[FHIR Export]
    end

    subgraph Server ["Bun.ts Server (Port 3500)"]
        TX[Terminology Search<br/>(SQLite FTS5)]
        VAL[FHIR Validator<br/>(Java Subprocess)]
    end

    subgraph External ["External Services"]
        EXTLLM[LLM Provider<br/>(e.g., OpenAI)]
        EXTFHIR[FHIR Server<br/>(e.g., HAPI)]
    end

    UI --> EXTLLM
    UI --> TX
    UI --> VAL
    VAL --> EXTFHIR
    EXP --> EXTFHIR
```

## 3. Prerequisites

Kiln requires minimal setup but depends on specific tools for its full functionality. Ensure you have the following installed before proceeding.

- **Bun.js (1.0+)**: The JavaScript runtime and package manager. Install via the official script:
  ```
  curl -fsSL https://bun.sh/install | bash
  ```
  Verify: `bun --version`. No Node.js is needed—Kiln uses Bun exclusively for its speed and native SQLite support.

- **Java JDK 17+**: Required for the FHIR validator (HAPI FHIR runs as a Java subprocess). Install OpenJDK 17 or later:
  - macOS: `brew install openjdk@17`
  - Ubuntu/Debian: `sudo apt update && sudo apt install openjdk-17-jdk`
  - Windows: Download from [Oracle](https://www.oracle.com/java/technologies/downloads/#java17) or [Adoptium](https://adoptium.net/).
  Verify: `java -version` (should show 17+). Set `JAVA_HOME` if needed.

- **Git**: For cloning the repository and optional vocabulary submodule. Most systems have it pre-installed; verify with `git --version`. If missing:
  - macOS: `brew install git`
  - Ubuntu/Debian: `sudo apt install git`
  - Windows: Download from [git-scm.com](https://git-scm.com/).

- **Operating System**: macOS, Linux, or Windows (via WSL recommended for native performance). Native Windows is supported but may require adjustments for Java paths.

- **Hardware**: At least 4GB RAM (validator defaults to 4g heap; adjust via `VALIDATOR_HEAP` env var). Disk space: ~2GB for vocabularies (SQLite + JAR).

- **No Additional Dependencies**: Bun handles all JavaScript/TypeScript compilation. No npm, Yarn, or build tools like Webpack are required.

### Verify Setup
Run these commands to confirm everything works:
```
bun --version  # Should show 1.0+
java -version  # Should show 17+
git --version  # Should show 2.0+
```

If any fail, install the missing tool and retry. For Docker users, see section 8 for a self-contained alternative.

**Notes**: Initial vocabulary loading (Step 3 below) takes 5-10 minutes on first run due to SQLite population. Subsequent starts are instant. If using WSL on Windows, ensure Java is accessible from the WSL environment.

```
git clone <repo-url> kiln && cd kiln
          |
          v
bun install  (client + server deps)
          |
          v
cd server && bun run scripts/setup.ts  (validator JAR + vocabularies)
          |
          v
bun run scripts/load-terminology.ts  (SQLite: LOINC/SNOMED/RxNorm)
          |
          v
bun run dev  (UI + APIs on port 3000)
```

## 4. Installation

Follow these steps to get Kiln running locally. The process sets up both the client (browser app) and server (APIs for terminology and validation). Initial vocabulary loading takes 5-10 minutes due to SQLite population (LOINC, SNOMED CT, RxNorm); subsequent runs are near-instant.

### Step 1: Clone and Install
Clone the repository and install dependencies with Bun (no Node.js required).

```
git clone https://github.com/jmandel/kiln.git
cd kiln
bun install
```

This installs client deps (React, Tailwind) at root and server deps (SQLite, Java subprocess) in `/server`. Verify: `bun --version` (should be 1.0+).

### Step 2: Setup Server
Navigate to the server directory and run the setup script. This downloads the FHIR validator JAR and configures the large-vocabularies submodule (pre-built NDJSON for LOINC/SNOMED/RxNorm).

```
cd server
bun run scripts/setup.ts
```

Expected output:
```
📥 Downloading FHIR validator...
✅ Downloaded validator JAR (X MB)
📥 Adding large vocabularies as git submodule...
✅ Large vocabularies submodule configured
```

If Java is not found, ensure JDK 17+ is installed (`java -version`). The script handles JAR download and git setup automatically.

### Step 3: Load Vocabularies
Populate the local SQLite database with terminology (LOINC, SNOMED CT, RxNorm). This step is required for offline terminology search and is the longest part of setup.

```
bun run scripts/load-terminology.ts
```

Expected output:
```
📦 Loading latest loinc: large-vocabularies/CodeSystem-loinc-*.ndjson.gz
✅ Loaded 12345 concepts from http://loinc.org
📦 Loading latest snomed: large-vocabularies/CodeSystem-snomed-*.ndjson.gz
✅ Loaded 67890 concepts from http://snomed.info/sct
📦 Loading latest rxnorm: large-vocabularies/CodeSystem-rxnorm-*.ndjson.gz
✅ Loaded 23456 concepts from http://www.nlm.nih.gov/research/umls/rxnorm
📦 Step 5: Optimizing database...
  • Creating FTS index for designations...
  • Building FTS index...
📊 Summary:
  • Code Systems: 3
  • Total Concepts: 103891
  • Total Designations: 456789
```

The database is saved to `./server/db/terminology.sqlite`. If it fails, check Java availability and disk space (~2GB needed).

### Step 4: Configure (Optional)
Server configuration uses environment variables in `.env.local` (create if missing; see `.env.example`).

- **Server Env Vars** (in `/server/.env.local`):
  - `VALIDATOR_HEAP=4g` (Java heap; adjust for low RAM, e.g., 2g).
  - `TERMINOLOGY_DB_PATH=./server/db/terminology.sqlite` (SQLite location; default).

- **Client Config** (via UI, saved to localStorage):
  - LLM API key (e.g., OpenAI/OpenRouter).
  - LLM base URL (e.g., `https://openrouter.ai/api/v1`).
  - Model (e.g., `openai/gpt-4o-mini`).
  - FHIR base URL (e.g., `https://r4.ontoserver.csiro.au/fhir`).
  - Validation services URL (e.g., `http://localhost:3500` for local; auto-detects same-origin otherwise).

Restart the server after env changes. Client settings persist across sessions.

### Verify
- **Config Check**: `bun run config:check` (validates env vars and config.json).
- **Tests**: `bun test` (server APIs: terminology search + validator; ~2 min).
- **Health**: Start dev server (`bun run dev`), visit http://localhost:3000, and check Settings → Status.

If vocabulary loading fails, run `bun run clean` and retry setup/load. For Docker, see section 8.

```
git clone + bun install
          |
          v
cd server + bun run scripts/setup.ts
          |
          v
bun run scripts/load-terminology.ts  (SQLite populated)
          |
          v
bun run dev  (Client + Server on port 3000)
```

## 5. Running Kiln

Kiln can be run in several modes, from local development to production deployment. The dev server combines the client and server for convenience, while production builds generate static files for hosting. All modes support the full workflow (authoring, LLM integration, validation). Ports are configurable via the `PORT` environment variable (default: 3000 for client/server combo, 3500 for server-only).

### Development Server (Recommended)
For local development, use the combined server that starts both the React client (port 3000) and Bun APIs (port 3500). Hot-reload works for client changes; server restarts on file changes.

```
bun run dev
```

This launches:
- **Client UI**: http://localhost:3000 (opens automatically in your default browser).
- **APIs**: http://localhost:3500 (e.g., `/health`, `/tx/search`).

Expected output:
```
🚀 Kiln Server v1.0
📱 Client: http://localhost:3000
🔧 APIs: http://localhost:3500
```

To start fresh (clears caches and rebuilds):
```
bun run dev:clean
```

Hot-reload: Edit TypeScript/React files in `/src` for instant UI updates. Server changes (e.g., in `/server`) require a manual restart. Use `Ctrl+C` to stop.

### Server Only (APIs + Validator)
Run the server standalone for API testing or headless use (no UI). This exposes terminology search and validation endpoints.

```
cd server
bun run dev
```

Server runs on http://localhost:3500. Test with:
```
curl http://localhost:3500/health
```

Expected response:
```json
{
  "status": "ok",
  "services": {
    "terminology": true,
    "validator": { "ready": true }
  }
}
```

Use this mode for integration testing or when embedding in another app. No client bundling occurs.

### Production Build
For deployment, generate a static build with embedded configuration. This creates a self-contained `/dist` directory (HTML/JS/CSS) that can be served by any static host.

```
bun run build
```

This produces:
- `dist/config.json`: Complete, validated configuration (no secrets).
- `dist/index.html`: Main app.
- `dist/viewer.html`: Standalone viewer for FHIR bundles.
- `dist/public/`: Assets (CSS, images).
- `dist/examples/`: Sample notes and bundles.
- `dist/build-manifest.json`: Build metadata.

Serve the build:
```
npx serve dist -l 3001 --cors
```

Access at http://localhost:3001. The build is optimized (minified, no source maps) and includes `STATIC_CONFIG` injection for offline config. For subpath deployment (e.g., `/kiln/`), set `PUBLIC_KILN_BASE_PATH=/kiln` before building.

Validate the build:
```
bun run build:validate
```

### Docker (Self-Contained)
Docker provides a containerized version with SQLite, validator, and vocabularies pre-loaded. No local Java or Bun install needed.

1. Build the image:
   ```
   docker build -t kiln .
   ```

2. Run (maps port 3000 for UI, 3500 for APIs):
   ```
   docker run -p 3000:3500 -e PUBLIC_KILN_BASE_URL=... kiln
   ```

   - Replace `...` with your LLM base (e.g., `https://openrouter.ai/api/v1`).
   - Add other `PUBLIC_KILN_*` env vars as needed (see section 6).
   - For persistence, mount a volume: `-v $(pwd)/data:/app/server/db`.

Expected output:
```
🚀 Kiln Server v1.0
📱 Client: http://localhost:3000
🔧 APIs: http://localhost:3500
```

Access UI at http://localhost:3000. The image is ~500MB (includes JAR, SQLite). For custom configs, extend the Dockerfile or use env vars.

### Ports
- **Client**: 3000 (UI + static assets).
- **Server**: 3500 (APIs: `/tx/*` for terminology, `/validate` for FHIR).
- **Customization**: Set `PORT=8080` to change (affects both in dev mode). For separate ports, use server-only mode.

### Diagram
```
Client (3000) ──► LLM (External) ──► Note → FHIR
    │
    └──► Server (3500) ──► SQLite (Terminology)
               │
               └──► Java Validator ──► FHIR Validation
```

**Notes**: Hot-reload in dev mode supports client changes (React/TSX); server requires restart. For clean starts, use `bun run dev:clean` (removes `dist/`, node_modules/.cache, bun.lockb). In production, the static build serves everything from one port (no separate server needed). Docker is ideal for testing or air-gapped environments—ensure ports don't conflict.

## 6. Configuration

Kiln's configuration is split between server-side environment variables (for infrastructure) and client-side settings (for user-specific secrets and endpoints). Server vars control the runtime environment (e.g., Java heap, database path), while client settings (stored in localStorage) handle API keys and service URLs. This separation ensures the server remains stateless and portable, with no shared secrets or user data. Changes to server env vars require a restart; client settings update instantly via the UI.

### Server-Side Environment Variables
Place these in `/server/.env.local` (create if missing; see `.env.example` for format). These affect the server process (APIs, validator) and are baked into static builds.

- **`PUBLIC_KILN_BASE_URL`**: Base URL for the LLM provider API. Required for LLM calls (e.g., generation, refinement).
  - Example: `https://openrouter.ai/api/v1`
  - Default: None (build fails without it).
  - Purpose: Endpoint for OpenAI-compatible APIs; must support `/chat/completions`.

- **`PUBLIC_KILN_MODEL`**: Name of the LLM model to use. Required; specify in "provider/model" format.
  - Example: `openai/gpt-4o-mini` or `meta/llama-3.1-8b-instruct:free`
  - Default: None (build fails without it).
  - Purpose: Controls creativity vs. precision (e.g., 0.8 temperature balances clinical tone).

- **`PUBLIC_KILN_TEMPERATURE`**: Sampling temperature for LLM calls (0.0 = deterministic, 2.0 = creative).
  - Example: `0.8`
  - Default: 0.8.
  - Purpose: Lower for precise FHIR generation; higher for narrative variety.

- **`PUBLIC_KILN_FHIR_BASE_URL`**: Base URL for the FHIR server (e.g., for validation or external resources).
  - Example: `https://r4.ontoserver.csiro.au/fhir`
  - Default: None (build fails without it).
  - Purpose: Used for Bundle resolution and external validation (if not local).

- **`PUBLIC_KILN_VALIDATION_SERVICES_URL`**: Endpoint for FHIR validation (e.g., `/validate`).
  - Example: `http://localhost:3500` (local server) or `https://your-validator.com/validate`
  - Default: Auto-detect (same-origin as client).
  - Purpose: Points to the Bun server or remote validator; empty string uses local Java subprocess.

- **`PUBLIC_KILN_FHIR_GEN_CONCURRENCY`**: Parallel resource generation (1 = sequential, 8 = max).
  - Example: `4`
  - Default: 1.
  - Purpose: Speeds up FHIR bundle creation (e.g., multiple Observations); balance with LLM rate limits.

- **`VALIDATOR_HEAP`**: Java heap size for the FHIR validator (adjust for low RAM).
  - Example: `2g`
  - Default: 4g.
  - Purpose: Handles large Bundles; increase if validation OOMs.

- **`TERMINOLOGY_DB_PATH`**: Path to the SQLite terminology database.
  - Example: `./server/db/terminology.sqlite`
  - Default: `./server/db/terminology.sqlite`.
  - Purpose: Local storage for LOINC/SNOMED/RxNorm; mount as volume in Docker.

After editing, restart the server (`bun run dev`). For static builds, re-run `bun run build` to regenerate `dist/config.json`.

### Client-Side Settings (UI)
These are configured via the Settings panel in the browser UI and persist in localStorage (per-browser, not shared). They override server defaults for flexibility (e.g., per-user API keys).

- **API Key**: LLM provider key (e.g., OpenAI or OpenRouter). Enter in Settings → LLM. Stored encrypted in localStorage.
  - Purpose: Authenticates LLM calls; required for generation/refinement. Clear localStorage to reset.

- **FHIR Base URL**: Overrides `PUBLIC_KILN_FHIR_BASE_URL` for this browser session.
  - Example: `https://your-fhir-server/fhir`
  - Purpose: Allows testing different FHIR endpoints without rebuild.

- **Validation Services URL**: Overrides `PUBLIC_KILN_VALIDATION_SERVICES_URL`.
  - Example: `https://your-validator.com/validate`
  - Purpose: Switch between local server and remote validators.

- **Model and Temperature**: Per-session overrides for the LLM (stored in localStorage).
  - Purpose: Experiment with models without server restart.

Access Settings via the gear icon. Changes apply immediately—no restart needed. To reset all client settings, clear browser localStorage (DevTools → Application → Storage → Clear).

### Mental Model
Think of server env vars as "infrastructure plumbing" (fixed at build/runtime, affect all users) and client settings as "user preferences" (dynamic, per-browser). The server provides defaults via `config.json` (injected into static builds), but localStorage takes precedence for secrets (API keys) and endpoints (LLM/FHIR URLs). No data flows between users—each browser is isolated. For production, set server vars securely (e.g., via Docker env or cloud secrets); client keys stay local.

### Configuration Diagram

| Variable | Purpose | Example Value | Default | Client Override? |
|----------|---------|---------------|---------|------------------|
| `PUBLIC_KILN_BASE_URL` | LLM API endpoint | `https://openrouter.ai/api/v1` | None (required) | Yes (UI) |
| `PUBLIC_KILN_MODEL` | LLM model | `openai/gpt-4o-mini` | None (required) | Yes (UI) |
| `PUBLIC_KILN_TEMPERATURE` | LLM creativity | `0.8` | 0.8 | Yes (UI) |
| `PUBLIC_KILN_FHIR_BASE_URL` | FHIR server base | `https://r4.ontoserver.csiro.au/fhir` | None (required) | Yes (UI) |
| `PUBLIC_KILN_VALIDATION_SERVICES_URL` | Validator endpoint | `http://localhost:3500` | Auto-detect | Yes (UI) |
| `PUBLIC_KILN_FHIR_GEN_CONCURRENCY` | Parallel generation | `4` | 1 | No |
| `VALIDATOR_HEAP` | Java heap size | `2g` | 4g | No |
| `TERMINOLOGY_DB_PATH` | SQLite path | `./server/db/terminology.sqlite` | `./server/db/terminology.sqlite` | No |

**Notes**: Table uses Markdown for clarity. Emphasize: Server vars in `.env.local` (git-ignored); client via UI (localStorage). For static builds, env vars generate `dist/config.json`—no localStorage needed for defaults. Warn: Expose no secrets in server env (e.g., use proxy for LLM keys).

## 7. Development

Kiln's development workflow leverages Bun's fast bundling and testing for rapid iteration. The project maintains high test coverage (>80% for server APIs) and uses Prettier for consistent formatting. Client changes (React/TSX) hot-reload automatically; server updates (Bun.ts) require restart. All tests focus on core functionality: terminology search, FHIR validation, and LLM integration (mocked for offline testing).

### Running Tests
Kiln includes unit and integration tests for the server (terminology search, validator) and basic client smoke tests. Tests use Bun's native test runner and mock external dependencies (LLM, FHIR server) for reliability.

- **All Tests**: Run the full suite (server-focused; client tests are lightweight):
  ```
  bun test
  ```
  Expected: ~2 minutes; coverage report in console. Tests validate FTS5 search (e.g., fuzzy matching across LOINC/SNOMED/RxNorm) and validator responses (structure, codings).

- **Watch Mode** (Dev): Auto-rerun on file changes:
  ```
  bun test --watch
  ```

- **Specific Suites**:
  - Terminology: `bun test server/tests/terminology.test.ts` (search accuracy, edge cases like empty queries).
  - Validator: `bun test server/tests/validator.test.ts` (structure validation, batch processing).
  - Coverage: `bun test --coverage` (generates reports; aim for 80%+).

Tests generate JSON reports (`server/tests/*-report.json`) for inspection (e.g., search hits, validation issues). FTS5 indexing ensures sub-50ms queries; validator tests use a headless Java subprocess.

### Adding Vocabularies
To extend terminology search (e.g., add UCUM or custom codes), use NDJSON format (gzipped for efficiency). Place files in `server/large-vocabularies/` and reload the database.

- **Format**: NDJSON.gz with first line as CodeSystem JSON, subsequent lines as Concept objects:
  ```
  {"resourceType":"CodeSystem","url":"http://example.com","version":"1.0"}
  {"code":"A01","display":"Example","designation":[{"use":{"code":"short"},"value":"Example A01"}]}
  {"code":"B01","display":"Example B","property":[{"code":"category","valueCode":"A"}]}
  ```
  Supports `designation` (for search) and `property` (for filters/relations).

- **Load**: Run the loader to populate SQLite:
  ```
  bun run server/scripts/load-terminology.ts
  ```
  Expected: `✅ Loaded X concepts from http://example.com`. Re-run after adding files (overwrites existing).

- **Custom Systems**: Ensure `url` matches FHIR CodeSystem (e.g., `http://example.com`). For hierarchical (SNOMED-like), use `property` with `code: "parent"`.

- **FTS5 Optimization**: The loader creates FTS5 indexes on `designations` for full-text search. Large systems (>50k concepts) index in ~1-2 min; use `PRAGMA optimize;` for production.

### Contributing
Contributions are welcome! Focus on improving LLM prompts, validation logic, or vocabulary integration. Fork the repo, make changes, and submit PRs with tests.

- **Workflow**:
  1. Fork and clone: `git clone <your-fork> && cd kiln && bun install`.
  2. Branch: `git checkout -b feature/add-vocabulary`.
  3. Develop: Edit in `/src` (client) or `/server` (APIs).
  4. Test: `bun test` (ensure no regressions).
  5. Format: `bun run format` (Prettier for TS/JS/JSON/MD/YAML).
  6. Lint: `bun run lint:fix` (enforces consistent style).
  7. Commit: Use semantic messages (e.g., "feat: add UCUM support").
  8. PR: Include test coverage and docs updates.

- **Guidelines**:
  - Keep PRs focused (one feature/fix).
  - Add tests for new functionality (e.g., new search filters).
  - Update README for user-facing changes (e.g., new env vars).
  - No breaking changes to APIs without discussion.

Test coverage targets 80%+ for server (search perf, validation); client tests are smoke-only (e.g., UI rendering). Use `bun test --coverage` to verify.

### Building
For production or custom deployments, generate a static build with embedded configuration.

- **Static Build**:
  ```
  bun run build
  ```
  Creates `/dist` with minified assets, `config.json` (baked-in env vars), and `build-manifest.json`. Validates output (required files, config integrity).

- **Validate Build**:
  ```
  bun run build:validate
  ```
  Checks for missing files and config errors (e.g., invalid URLs).

- **Custom Build**: Set `PUBLIC_KILN_*` env vars before building (e.g., `PUBLIC_KILN_MODEL=your-model bun run build`). For subpaths (e.g., `/app/`), use `PUBLIC_KILN_BASE_PATH=/app`.

The build is ~500KB (gzipped) and runs offline (after vocabulary load). No server needed for core features, but APIs enhance validation/search.

### Debugging
Debugging focuses on client (browser tools) and server (console/logs). Use Bun's fast restarts for iteration.

- **Server Logs**:
  - Console output shows startup (e.g., "Loaded X concepts"), requests (e.g., `/tx/search`), and errors (e.g., validator OOM).
  - Verbose: Set `DEBUG=* bun run dev` (includes SQLite queries, validator output).
  - Validator: Monitor Java logs in server console (e.g., "Listening on port 8080").

- **Client Debugging**:
  - Browser DevTools: Inspect localStorage (Settings → keys like `kiln.apiKey`, `kiln.fhirBase`).
  - Network Tab: Monitor LLM calls (`/chat/completions`), API requests (`/tx/search`, `/validate`).
  - Console: Logs LLM responses, validation issues (e.g., "Coding unresolved: hypertension").

- **Validator Debugging**:
  - Set `DEBUG=validator:*` env var: Logs Java subprocess (e.g., "Validating Bundle...").
  - Heap Issues: Increase `VALIDATOR_HEAP=6g` if OOM; check server console for "OutOfMemoryError".
  - Test Standalone: `cd server && bun run scripts/setup.ts` (downloads JAR); run `java -jar validator.jar -version 4.0` manually.

- **Common Debug Steps**:
  - Clear Caches: `bun run clean` (removes `dist/`, bun.lockb).
  - Reset Client: Browser DevTools → Application → Storage → Clear localStorage.
  - Vocabulary: Verify `bun run server/scripts/load-terminology.ts` (check `./server/db/terminology.sqlite` size ~2GB).
  - Ports: Ensure 3000/3500 free; use `lsof -i :3000` to kill conflicts.

For LLM issues, test endpoints directly (e.g., `curl http://localhost:3500/tx/search -d '{"queries":["hypertension"]}'`). FTS5 ensures fast search (sub-50ms); validator latency is ~1-5s for Bundles.

**Notes**: Include commands for common fixes (e.g., `bun run clean`). Mention FTS5 perf (SQLite indexes on `designations` for fuzzy search). No subsections beyond bullets for brevity.

## 8. Deployment

Kiln supports multiple deployment strategies, from simple static hosting to containerized production setups. The static build (recommended for most cases) serves the client directly from a CDN, while Docker provides a self-contained option with the server included. For high-traffic scenarios, deploy the Bun server on a VPS or cloud platform. All modes require setting `PUBLIC_KILN_*` environment variables for LLM and FHIR endpoints—see section 6 for details. The SQLite database (vocabularies) persists via volume mounts in containerized or server deployments.

### Static Hosting (Recommended)
Static hosting is the simplest option, leveraging the optimized build (`/dist`) for zero-server maintenance. The client runs entirely in the browser, with config injected at build time (`dist/config.json`). No runtime server needed, but ensure your host supports CORS for API calls (LLM/FHIR).

- **Build**: Generate the production bundle with embedded configuration.
  ```
  bun run build
  ```
  This creates `/dist` (~500KB gzipped) with `config.json`, HTML/JS/CSS, and examples. Validates output automatically.

- **Deploy**:
  - **Netlify/Vercel**: Drag `/dist` to deploy (auto-detects static files). Set `PUBLIC_KILN_*` as site environment variables in the dashboard (e.g., Netlify → Site settings → Environment variables).
  - **GitHub Pages**: Push `/dist` to a `gh-pages` branch or use Actions to build/deploy.
  - **Cloud Storage**: Upload to S3, GCS, or similar; enable public access and CORS (allow `*` for dev, restrict for prod).
  - **Any Static Server**: Use `npx serve dist -l 3001 --cors` locally or Apache/Nginx.

- **Config**: Environment variables are baked into `config.json` during build. For subpath deployment (e.g., `/kiln/`), set `PUBLIC_KILN_BASE_PATH=/kiln` before building. Client-side overrides (API keys) use localStorage.

- **Scaling**: Infinite (CDN handles load). For custom domains, update `config.json` post-build or use a proxy to rewrite paths.

### Docker (Self-Contained)
Docker bundles the client, server, SQLite database, and validator into a single container. Ideal for testing, air-gapped environments, or quick deploys without local setup. The image includes pre-loaded vocabularies (~2GB) and runs on port 3000 (UI) + 3500 (APIs).

- **Build**: Create the image from the Dockerfile (includes all deps: Bun, Java, SQLite).
  ```
  docker build -t kiln:latest .
  ```
  Tag with version: `docker build -t kiln:v1.0 .`.

- **Run**:
  ```
  docker run -p 3000:3000 -p 3500:3500 \
    -e PUBLIC_KILN_BASE_URL=https://openrouter.ai/api/v1 \
    -e PUBLIC_KILN_MODEL=openai/gpt-4o-mini \
    -e PUBLIC_KILN_FHIR_BASE_URL=https://r4.ontoserver.csiro.au/fhir \
    kiln:latest
  ```
  - Ports: 3000 (UI), 3500 (APIs).
  - Env Vars: Set `PUBLIC_KILN_*` as shown (required for LLM/FHIR).
  - Persistence: Mount a volume for the database: `-v $(pwd)/data:/app/server/db` (SQLite WAL/SHM files).

- **Advanced**:
  - **Multi-Instance**: Run multiple containers behind a load balancer (stateless except SQLite; use shared volume or replicas).
  - **Custom Config**: Extend Dockerfile or use `--env-file` for `.env.local`.
  - **Health Check**: Docker supports built-in health (curl `/health`); add to `docker-compose.yml` for orchestration.
  - **Docker Compose**: Example `docker-compose.yml`:
    ```yaml
    version: '3.1'
    services:
      kiln:
        image: kiln:latest
        ports:
          - "3000:3000"
          - "3500:3500"
        environment:
          - PUBLIC_KILN_BASE_URL=https://openrouter.ai/api/v1
          - PUBLIC_KILN_MODEL=openai/gpt-4o-mini
          - PUBLIC_KILN_FHIR_BASE_URL=https://r4.ontoserver.csiro.au/fhir
        volumes:
          - ./data:/app/server/db  # Persistent SQLite
    ```

- **Image Size**: ~500MB (Bun runtime + JAR + SQLite). Pull with `docker pull jmandel/kiln:latest` (pre-built on Docker Hub).

### VPS/Cloud
For production or custom scaling, deploy the Bun server on a VPS (e.g., DigitalOcean, AWS EC2) or cloud platform (e.g., Render, Fly.io). The server handles APIs (search/validation); serve the static build from the same host or CDN.

- **Setup**:
  - Clone repo: `git clone <repo> && cd kiln && bun install`.
  - Build static assets: `bun run build` (optional; serve `/dist` via Nginx).
  - Run server: `bun run preview` (port 3500; production mode).
  - Use PM2 for process management: `npm i -g pm2 && pm2 start "bun run preview" --name kiln`.
  - Systemd (Linux): Create `/etc/systemd/system/kiln.service`:
    ```ini
    [Unit]
    Description=Kiln Server
    After=network.target

    [Service]
    Type=simple
    User=www-data
    WorkingDirectory=/path/to/kiln
    Environment=NODE_ENV=production
    ExecStart=/usr/local/bin/bun run preview
    Restart=always

    [Install]
    WantedBy=multi-user.target
    ```
    Enable: `sudo systemctl enable kiln && sudo systemctl start kiln`.

- **Volume Mount**: Persist SQLite: Mount `./server/db` as a volume (e.g., AWS EBS, DigitalOcean Volumes). Ensure read/write access for WAL/SHM files.

- **Env Vars**: Set `PUBLIC_KILN_*` in your deployment platform (e.g., Render dashboard). For HTTPS, use a reverse proxy (Nginx/Caddy) with Let's Encrypt.

- **Scaling Notes**: The server is stateless except for SQLite (single writer; use read replicas for >100 QPS). Validator is CPU-bound—scale horizontally (multiple instances, shared DB). Monitor Java heap via logs; adjust `VALIDATOR_HEAP` for large Bundles. For high load, offload validation to a remote service (set `PUBLIC_KILN_VALIDATION_SERVICES_URL`).

- **Reverse Proxy Example** (Nginx for VPS):
  ```
  server {
    listen 80;
    server_name your-domain.com;

    # Static assets (from build)
    location / {
      root /path/to/kiln/dist;
      try_files $uri $uri/ /index.html;
    }

    # APIs (Bun server)
    location /api {
      proxy_pass http://localhost:3500;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
    }
  }
  ```

### Scaling Notes
Kiln scales easily due to its stateless design:
- **Static Client**: Infinite scale via CDN (Netlify/Vercel handle millions of requests).
- **Server APIs**: Stateless except SQLite (use read replicas for terminology search; shared volume for writes). Validator instances can be load-balanced (CPU-intensive; 1-2s per Bundle).
- **Bottlenecks**: LLM rate limits (e.g., OpenAI: 60 RPM for GPT-4o-mini); mitigate with queuing or multiple keys. SQLite handles ~100 QPS; upgrade to PostgreSQL for >1k QPS.
- **Monitoring**: Use Prometheus (expose `/health` metrics) or cloud logs. Track validator uptime (Java GC pauses) and search latency (FTS5 ensures <50ms).

For production, enable HTTPS (free via Let's Encrypt) and restrict CORS (e.g., allow only your domain). Use a secrets manager for env vars (no API keys in server config).

### Diagram

```
Static (Netlify/Vercel):
  dist/ ──► CDN ──► Browser
  (Config via env vars)

Docker (Self-Contained):
  Dockerfile ──► Container
  (SQLite + Validator bundled)

VPS:
  Bun server ──► Nginx/Proxy
  (Mount /db for persistence)
```

## 9. Development

Kiln's development workflow leverages Bun's fast bundling and testing for rapid iteration. The project maintains high test coverage (>80% for server APIs) and uses Prettier for consistent formatting. Client changes (React/TSX) hot-reload automatically; server updates (Bun.ts) require restart. All tests focus on core functionality: terminology search, FHIR validation, and LLM integration (mocked for offline testing).

### Running Tests
Kiln includes unit and integration tests for the server (terminology search, validator) and basic client smoke tests. Tests use Bun's native test runner and mock external dependencies (LLM, FHIR server) for reliability.

- **All Tests**: Run the full suite (server-focused; client tests are lightweight):
  ```
  bun test
  ```
  Expected: ~2 minutes; coverage report in console. Tests validate FTS5 search (e.g., fuzzy matching across LOINC/SNOMED/RxNorm) and validator responses (structure, codings).

- **Watch Mode** (Dev): Auto-rerun on file changes:
  ```
  bun test --watch
  ```

- **Specific Suites**:
  - Terminology: `bun test server/tests/terminology.test.ts` (search accuracy, edge cases like empty queries).
  - Validator: `bun test server/tests/validator.test.ts` (structure validation, batch processing).
  - Coverage: `bun test --coverage` (generates reports; aim for 80%+).

Tests generate JSON reports (`server/tests/*-report.json`) for inspection (e.g., search hits, validation issues). FTS5 indexing ensures sub-50ms queries; validator tests use a headless Java subprocess.

### Adding Vocabularies
To extend terminology search (e.g., add UCUM or custom codes), use NDJSON format (gzipped for efficiency). Place files in `server/large-vocabularies/` and reload the database.

- **Format**: NDJSON.gz with first line as CodeSystem JSON, subsequent lines as Concept objects:
  ```
  {"resourceType":"CodeSystem","url":"http://example.com","version":"1.0"}
  {"code":"A01","display":"Example","designation":[{"use":{"code":"short"},"value":"Example A01"}]}
  {"code":"B01","display":"Example B","property":[{"code":"category","valueCode":"A"}]}
  ```
  Supports `designation` (for search) and `property` (for filters/relations).

- **Load**: Run the loader to populate SQLite:
  ```
  bun run server/scripts/load-terminology.ts
  ```
  Expected: `✅ Loaded X concepts from http://example.com`. Re-run after adding files (overwrites existing).

- **Custom Systems**: Ensure `url` matches FHIR CodeSystem (e.g., `http://example.com`). For hierarchical (SNOMED-like), use `property` with `code: "parent"`.

- **FTS5 Optimization**: The loader creates FTS5 indexes on `designations` for full-text search. Large systems (>50k concepts) index in ~1-2 min; use `PRAGMA optimize;` for production.

### Contributing
Contributions are welcome! Focus on improving LLM prompts, validation logic, or vocabulary integration. Fork the repo, make changes, and submit PRs with tests.

- **Workflow**:
  1. Fork and clone: `git clone <your-fork> && cd kiln && bun install`.
  2. Branch: `git checkout -b feature/add-vocabulary`.
  3. Develop: Edit in `/src` (client) or `/server` (APIs).
  4. Test: `bun test` (ensure no regressions).
  5. Format: `bun run format` (Prettier for TS/JS/JSON/MD/YAML).
  6. Lint: `bun run lint:fix` (enforces consistent style).
  7. Commit: Use semantic messages (e.g., "feat: add UCUM support").
  8. PR: Include test coverage and docs updates.

- **Guidelines**:
  - Keep PRs focused (one feature/fix).
  - Add tests for new functionality (e.g., new search filters).
  - Update README for user-facing changes (e.g., new env vars).
  - No breaking changes to APIs without discussion.

Test coverage targets 80%+ for server (search perf, validation); client tests are smoke-only (e.g., UI rendering). Use `bun test --coverage` to verify.

### Building
For production or custom deployments, generate a static build with embedded configuration.

- **Static Build**:
  ```
  bun run build
  ```
  Creates `/dist` with minified assets, `config.json` (baked-in env vars), and `build-manifest.json`. Validates output automatically.

- **Validate Build**:
  ```
  bun run build:validate
  ```
  Checks for missing files and config errors (e.g., invalid URLs).

- **Custom Build**: Set `PUBLIC_KILN_*` env vars before building (e.g., `PUBLIC_KILN_MODEL=your-model bun run build`). For subpaths (e.g., `/app/`), use `PUBLIC_KILN_BASE_PATH=/app`.

The build is ~500KB (gzipped) and runs offline (after vocabulary load). No server needed for core features, but APIs enhance validation/search.

### Debugging
Debugging focuses on client (browser tools) and server (console/logs). Use Bun's fast restarts for iteration.

- **Server Logs**:
  - Console output shows startup (e.g., "Loaded X concepts"), requests (e.g., `/tx/search`), and errors (e.g., validator OOM).
  - Verbose: Set `DEBUG=* bun run dev` (includes SQLite queries, validator output).
  - Validator: Monitor Java logs in server console (e.g., "Listening on port 8080").

- **Client Debugging**:
  - Browser DevTools: Inspect localStorage (Settings → keys like `kiln.apiKey`, `kiln.fhirBase`).
  - Network Tab: Monitor LLM calls (`/chat/completions`), API requests (`/tx/search`, `/validate`).
  - Console: Logs LLM responses, validation issues (e.g., "Coding unresolved: hypertension").

- **Validator Debugging**:
  - Set `DEBUG=validator:*` env var: Logs Java subprocess (e.g., "Validating Bundle...").
  - Heap Issues: Increase `VALIDATOR_HEAP=6g` if OOM; check server console for "OutOfMemoryError".
  - Test Standalone: `cd server && bun run scripts/setup.ts` (downloads JAR); run `java -jar validator.jar -version 4.0` manually.

- **Common Debug Steps**:
  - Clear Caches: `bun run clean` (removes `dist/`, bun.lockb).
  - Reset Client: Browser DevTools → Application → Storage → Clear localStorage.
  - Vocabulary: Verify `bun run server/scripts/load-terminology.ts` (check `./server/db/terminology.sqlite` size ~2GB).
  - Ports: Ensure 3000/3500 free; use `lsof -i :3000` to kill conflicts.

For LLM issues, test endpoints directly (e.g., `curl http://localhost:3500/tx/search -d '{"queries":["hypertension"]}'`). FTS5 ensures fast search (sub-50ms); validator latency is ~1-5s for Bundles.

## 10. Troubleshooting

Kiln's local-first design minimizes issues, but setup (Java, vocabularies) or configuration (env vars, API keys) can cause problems. Below are common errors and fixes. Most resolve with simple steps like clearing caches or verifying dependencies. For persistent issues, check logs and report on GitHub (include server console output, browser network tab screenshots, and `bun run config:check` results).

### Common Issues
- **Bun Not Found**:
  - Error: `bun: command not found`.
  - Fix: Install Bun via the official script: `curl -fsSL https://bun.sh/install | bash`. Restart your terminal and verify with `bun --version` (should be 1.0+). No Node.js is needed—Kiln uses Bun exclusively.

- **Java Error**:
  - Error: `java: command not found` or "Unsupported major.minor version" during vocabulary load or validation.
  - Fix: Ensure JDK 17+ is installed and in your PATH. Verify: `java -version` (should show 17+). On macOS: `brew install openjdk@17 && export JAVA_HOME=/opt/homebrew/opt/openjdk@17`. On Ubuntu: `sudo apt install openjdk-17-jdk`. For WSL, install in WSL and ensure `JAVA_HOME` is set. If using Docker, the image includes Java—no local install needed.

- **Vocabulary Load Fails**:
  - Error: "No concepts loaded" or SQLite errors during `load-terminology.ts`.
  - Fix: Re-run `bun run server/scripts/load-terminology.ts` manually and watch for errors (e.g., disk space, Java heap). Check `./server/db/terminology.sqlite` size (~2GB if successful). If it hangs, increase `VALIDATOR_HEAP=6g` in `/server/.env.local` and retry. Ensure the `large-vocabularies` submodule is updated: `cd server/large-vocabularies && git pull`.

- **Validator Crashes**:
  - Error: "OutOfMemoryError" or validator fails to start (check server console for Java stack traces).
  - Fix: Increase heap in `/server/.env.local`: `VALIDATOR_HEAP=6g` (or higher for large Bundles). Verify JAR path: `bun run server/scripts/setup.ts` re-downloads if missing. Test standalone: `cd server && java -jar validator.jar -version 4.0`. If on low RAM (<4GB), use a remote validator URL instead (set `PUBLIC_KILN_VALIDATION_SERVICES_URL`).

- **CORS Errors**:
  - Error: Browser network tab shows "CORS policy" blocks for `/tx/search` or `/validate`.
  - Fix: The server allows all origins by default (`*`). If deploying, ensure your proxy/CDN forwards CORS headers. For local dev, use the combined server (`bun run dev`). Test APIs directly: `curl http://localhost:3500/health`. If using a remote validator, set it in UI Settings.

- **No Terminology Results**:
  - Error: Empty search results for common terms (e.g., "hypertension").
  - Fix: Ensure vocabulary loading succeeded: Run `bun run server/scripts/load-terminology.ts` and confirm "Loaded X concepts" (X > 100k). Check database size: `ls -lh ./server/db/terminology.sqlite` (~2GB). If zero results, verify FTS5 index: `sqlite3 ./server/db/terminology.sqlite "SELECT COUNT(*) FROM designations_fts;"` (should match concept count). Restart server after loading.

- **LLM Calls Fail**:
  - Error: "401 Unauthorized" or "Invalid API key" in browser console.
  - Fix: Enter a valid API key in UI Settings (e.g., OpenAI/OpenRouter). Test the endpoint: `curl -H "Authorization: Bearer sk-..." https://openrouter.ai/api/v1/chat/completions -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"test"}]}'`. Ensure `PUBLIC_KILN_BASE_URL` and `PUBLIC_KILN_MODEL` are set correctly (e.g., `https://openrouter.ai/api/v1`, `openai/gpt-4o-mini`). Check rate limits in provider dashboard.

### Logs
- **Server Logs**: 
  - Primary: Terminal/console where you run `bun run dev` or `bun run preview`. Shows startup ("Loaded X concepts"), requests (e.g., "GET /tx/search"), and errors (e.g., validator OOM, SQLite issues).
  - Verbose Mode: Prefix with `DEBUG=*` (e.g., `DEBUG=* bun run dev`) for detailed output: SQLite queries, validator subprocess logs, and API traces.
  - File Logging: Redirect to file: `bun run dev > server.log 2>&1`.

- **Client Logs**:
  - Browser DevTools → Console: Logs LLM responses (e.g., "Generated outline"), validation issues (e.g., "3 unresolved codings"), and errors (e.g., "API key invalid").
  - Network Tab: Inspect requests to LLM (`/chat/completions`), terminology (`/tx/search`), and validation (`/validate`). Look for 4xx/5xx status codes.

- **Validator Logs**:
  - Integrated in server console (stdout/stderr from Java subprocess). Errors like "OutOfMemoryError" or "Failed to validate" appear here.
  - Standalone Test: `cd server && java -jar validator.jar -server 8080` (separate process; logs to console).

### Reset
- **Clear Caches and Rebuild**:
  ```
  bun run clean
  ```
  Removes `/dist`, `node_modules/.cache`, and `bun.lockb`. Re-install deps with `bun install` and rebuild.

- **Reset Client State**:
  - Browser DevTools → Application → Storage → Local Storage → Clear (resets API keys, settings, recent notes).
  - Or: `localStorage.clear()` in console.

- **Reset Database** (Vocabularies):
  ```
  rm ./server/db/terminology.sqlite
  bun run server/scripts/load-terminology.ts
  ```
  Re-populates SQLite from NDJSON (5-10 min).

- **Full Reset**:
  ```
  bun run clean
  rm -rf server/db/*
  bun install
  cd server && bun run scripts/setup.ts
  bun run scripts/load-terminology.ts
  ```
  Restarts from scratch (downloads JAR, vocabularies, rebuilds DB).

For issues not covered here, run `bun run config:check` to validate env vars, then report on GitHub with logs (server console, browser network tab) and steps to reproduce. Include your OS, Bun version (`bun --version`), and Java version (`java -version`).



## 12. License

Kiln is open-source software licensed under the MIT License. See the [LICENSE](LICENSE) file for full details.

### Dependencies
All JavaScript/TypeScript dependencies are listed in `package.json` and follow their respective licenses (mostly MIT/Apache 2.0). Key libraries include:
- **Bun.js**: MIT (runtime and bundler).
- **React 19**: MIT (UI framework).
- **Tailwind CSS**: MIT (styling).
- **Marked**: MIT (Markdown parsing).
- **SQLite**: Public Domain (via Bun's native support).
- **HAPI FHIR Validator**: Apache 2.0 (Java-based; included JAR).

Run `bun pm ls` to view installed packages and their licenses. No proprietary dependencies are used.

### Vocabularies
Kiln includes pre-loaded terminology from public sources, each with specific usage terms:
- **LOINC** (Logical Observation Identifiers Names and Codes): Copyright © 1995-2024 Regenstrief Institute, Inc. Freely available under the [LOINC License](http://loinc.org/license). Non-commercial use; attribution required ("Courtesy of LOINC®").
- **SNOMED CT** (International Health Terminology Standards Development Organisation): Copyright © 2002-2024 SNOMED International. Licensed for use under the [SNOMED CT Browser License](https://www.snomed.org/snomed-ct/browser-license). International non-commercial distribution; requires IHTSDO affiliate agreement for production.
- **RxNorm** (National Library of Medicine): Public domain (U.S. Government work). Freely usable and redistributable without permission. Attribution: "Source: U.S. National Library of Medicine."

For production use, review terms at:
- LOINC: http://loinc.org/license
- SNOMED CT: https://www.snomed.org/snomed-ct/get-snomed-ct
- RxNorm: https://www.nlm.nih.gov/research/umls/rxnorm/docs/rxnormlicense.html

Vocabularies are loaded via `server/scripts/load-terminology.ts` from NDJSON files in `server/large-vocabularies/`. Custom vocabularies (NDJSON.gz) can be added following FHIR CodeSystem format—see section 9 for details. Ensure compliance with source licenses for any redistribution or commercial deployment.

