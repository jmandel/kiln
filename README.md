# Kiln: Clinical Narrative From Raw Clay

Kiln is a browser-based tool for iteratively shaping raw patient sketches into realistic clinical notes and IPS-compliant FHIR Bundles using LLMs for synthesis and external services for validation, built by Josh Mandel, MD.

## 1. Overview

Kiln is a browser-based tool that transforms unstructured patient sketches into clinically realistic narrative notes and standardized FHIR Bundles. By leveraging large language models (LLMs) for iterative content synthesis, it bridges the gap between free-form clinical descriptions and interoperable structured data, with built-in validation to ensure compliance with FHIR R4 and IPS profiles.

### Purpose
Kiln enables rapid prototyping of clinical documentation workflows. Users input a simple patient sketch (e.g., "52F with chest pain, onset 2 weeks ago"), and the system generates a comprehensive narrative note through guided LLM prompts, followed by automatic mapping to a FHIR Document Bundle. It emphasizes evidence-based realism in narratives while enforcing canonical coding (e.g., SNOMED for problems, LOINC for observations) and structure validation, making it ideal for exploring AI-driven content generation without deep FHIR expertise.

### Key Features
- **Narrative Generation from Sketches:** Start with a brief patient description; Kiln uses LLMs to create a structured outline, draft sections (e.g., HPI, exam, assessment), and assemble a cohesive Markdown note with iterative refinement loops for quality control.
- **Automatic FHIR Conversion:** Extracts sections from the narrative to build an IPS-compliant Composition, generates discrete resources (e.g., Observation, Condition, MedicationRequest), and assembles a validated Bundle ready for clinical systems.
- **Terminology Search:** Integrated lookup across SNOMED CT, LOINC, RxNorm, and FHIR code systems, with fuzzy matching and code existence checks to support accurate coding during generation.
- **FHIR Validation:** Real-time structure and conformance checks against R4/IPS using an embedded HAPI validator, surfacing issues like unresolved references or invalid codes for quick fixes.
- **Browser-Based UI:** Intuitive dashboard for sketching, reviewing artifacts (outlines, drafts, bundles), and managing workflows, with support for chaining narratives to FHIR.

### Target Users
Kiln targets clinicians exploring AI for documentation, informaticians building content pipelines, and developers prototyping FHIR integrations. It's particularly useful for generating synthetic data for testing or educational purposes, though it's not intended as a production electronic medical record (EMR) system.

### Limitations
Kiln depends on external services for LLM inference (e.g., OpenRouter) and FHIR validation (HAPI Java server), which may incur costs or require configuration. Outputs are LLM-generated and should be reviewed for clinical accuracy; it's not a substitute for professional judgment or certified medical software.

```
Patient Sketch → LLM Synthesis → Narrative Note → FHIR Generation → Validated Bundle
                  (Iterative refinement)          (IPS-compliant)
```

## 2. Mental Models

Kiln's design draws from the metaphor of pottery: clinical sketches are raw "clay" that can be molded iteratively into a human-readable narrative, then "fired" into a durable, standardized FHIR Bundle. This separation ensures flexibility in content creation while maintaining interoperability. The system uses LLMs to infuse realism and clinical plausibility, guided by structured prompts that draw on evidence-based medicine, while validation loops catch and resolve issues like invalid codes or structural errors.

### Core Concept: From Sketch to Structure
At its heart, Kiln transforms a concise patient sketch into a complete clinical document. The process begins with a natural language input, such as "52F with chest pain, onset 2 weeks ago," which serves as the seed for LLM-driven synthesis. The LLM first creates a logical outline with section briefs (e.g., Chief Complaint, HPI, Physical Exam, Assessment, Plan), ensuring coverage of key clinical elements like symptoms, history, and risks. Each section is then expanded into detailed prose, drawing on the sketch for plausible, evidence-based details—such as radiation patterns for pain or typical exam findings—while avoiding fabrication.

Refinement happens through score-based loops: drafts are critiqued for realism, consistency, and synthesis (e.g., no duplication across sections), and low scores trigger revisions until quality thresholds are met. The final narrative is assembled as Markdown, preserving readability. For FHIR, the system maps sections to an IPS Composition, generates discrete resources (e.g., Observation for vitals, Condition for diagnoses, MedicationRequest for orders), and produces a Bundle with fullUrl references and embedded narratives from the original note.

### Workflow Layers
Kiln's pipeline separates concerns across three layers, each optimized for its role:

- **Clay (Narrative Layer):** This is the malleable, human-focused stage. LLMs are prompted to generate content iteratively, emphasizing clinical realism (e.g., patient quotes, exam descriptions) over structure. Prompts guide the model to expand sketches with details like onset, severity, and comorbidities, using a critique loop where scores below thresholds (e.g., 0.75 for sections) prompt rewrites. The output is a cohesive Markdown note, editable and reviewable in the UI.

- **Firing (FHIR Layer):** Here, the narrative is transformed into structured data. Sections are extracted (e.g., HPI → Condition/Observation) and mapped to IPS resources, with placeholders for entries (e.g., "Observation/obs-bp-1" for blood pressure). LLMs generate individual resources with canonical codes (SNOMED for problems, LOINC for labs), ensuring each Observation focuses on one facet (e.g., systolic BP as a component). The result is a Bundle with Composition as the root, linking all resources via references to a shared Patient and Encounter.

- **Validation Layer:** This enforces standards without disrupting creativity. Terminology searches (via SQLite FTS) verify codes exist in SNOMED/LOINC/RxNorm; unresolved ones get annotated extensions (e.g., `http://kraken.fhir.me/StructureDefinition/coding-issue`). Structure validation uses HAPI to check R4/IPS conformance, rejecting invalid patches and surfacing issues like missing fullUrl or code mismatches for refinement.

```mermaid
graph TD
    A[Patient Sketch] --> B[LLM: Outline & Briefs]
    B --> C[LLM: Section Drafts<br/>(Iterative Critique)]
    C --> D[Assemble Narrative]
    D --> E[Extract Sections →<br/>Composition Plan]
    E --> F[LLM: Generate Resources<br/>(Observation, Condition, etc.)]
    F --> G[Refine & Validate<br/>(Terminology + Structure)]
    G --> H[FHIR Bundle<br/>(IPS-Compliant)]
    H --> I[Final Validation]
    style A fill:#f9f
    style H fill:#bbf
```

### Key Decisions
Several choices shape Kiln's behavior to balance creativity and compliance:

- **LLM Prompting:** Prompts prioritize canonical coding (e.g., SNOMED for conditions, LOINC for observations) but permit narrative fallbacks for ambiguous cases, avoiding over-reliance on the model for precise FHIR specs. IPS guidance is embedded as structured notes (e.g., "use LOINC for single measurements") rather than full R4 rules, keeping prompts concise and focused on clinical synthesis.

- **Validation Loops:** During FHIR generation, unresolved codings trigger terminology searches (e.g., via `/tx/search`), with results fed back to the LLM for refinement. Invalid patches (e.g., partial Coding updates) are rejected, and issues are annotated as extensions (e.g., `coding-issue` for unresolved codes) rather than halting the process, allowing partial success.

- **Error Handling:** The system favors graceful degradation: narrative notes are always generated, even if FHIR validation fails, with placeholders (e.g., `<requires search_for_coding>`) for missing codes. This ensures usability while providing clear feedback for manual intervention.

These models ensure Kiln produces both readable narratives and valid FHIR, making it a practical tool for clinical content exploration.

## 3. Setup

Kiln requires Bun (the JavaScript runtime) for the development server and Java 17+ for the embedded FHIR validator. The terminology database uses SQLite for efficient local storage. Follow these steps to get started.

### Prerequisites
- **Bun 1.0+**: Install via `curl -fsSL https://bun.sh/install | bash`. Verify with `bun --version`.
- **Java 17+**: Required for the HAPI FHIR validator. Install via your package manager (e.g., `apt install openjdk-17-jre` on Debian-based systems) or from [Adoptium](https://adoptium.net/). Set `JAVA_HOME` if multiple versions are installed. Verify with `java -version`.
- **Git**: For cloning the repository and managing the vocabulary submodule. Install via your package manager (e.g., `apt install git`).

If you're using Docker, no additional prerequisites are needed beyond Docker itself.

### Installation Steps
1. **Clone the Repository:**
   ```
   git clone https://github.com/joshmandel/kiln.git
   cd kiln
   ```

2. **Install Root Dependencies:**
   ```
   bun install
   ```
   This sets up the browser UI and shared packages.

3. **Setup Server Dependencies:**
   ```
   cd server
   bun install
   ```
   This installs server-specific packages.

4. **Download Validator and Vocabularies:**
   ```
   cd server
   bun run setup.ts
   ```
   This downloads the FHIR validator JAR, sets up the large-vocabularies Git submodule (containing LOINC, SNOMED CT, and RxNorm), and prepares the SQLite database structure.

5. **Load Terminology Database:**
   ```
   cd server
   bun run scripts/load-terminology.ts
   ```
   This populates the SQLite database (`./server/db/terminology.sqlite`) with terminology from the vocabularies. The process may take several minutes for initial load; subsequent runs are faster.

Once complete, the database will contain searchable concepts from major code systems, optimized with FTS5 for fast lookups.

### Environment Variables
Configure these in your shell or `.env` file. Defaults are shown for local development.

- `PORT`: Server port for the full app (default: 3000). For APIs only, use port 3500 from the `./server` directory.
- `VALIDATOR_HEAP`: Java heap size for the validator (default: 4g). Increase for large resources (e.g., `8g` for production).
- `TERMINOLOGY_DB_PATH`: Path to the SQLite terminology database (default: `./server/db/terminology.sqlite`). Use absolute paths for persistence in Docker.

Reload the environment after changes or restart the server.

### Configuration (Unified Defaults)
Kiln uses a unified configuration system that works at build time (for static assets) and at runtime (via the Bun server). This provides sensible defaults without leaking secrets and keeps the UI, build, and server in sync.

- Build-time defaults: When running the static build (`bun run build:static`), non-secret defaults are injected into the bundle as `DEFAULT_VALUES` via Bun’s `define`. These include model, temperature, FHIR base URL, validation services URL, and concurrency.
- Runtime defaults: The dev/prod server exposes `GET /api/config/defaults`, returning public environment variables for the client to read. The API never includes secrets.
- UI behavior: The Settings modal shows any build/runtime defaults and uses them as fallbacks when fields are blank. LocalStorage values override defaults.

Public environment variables (read at build-time and/or runtime):

```
PUBLIC_KILN_BASE_URL                # LLM API base URL (e.g., https://openrouter.ai/api/v1)
PUBLIC_KILN_MODEL                   # LLM model id (e.g., openai/gpt-4)
PUBLIC_KILN_TEMPERATURE             # Default temperature (e.g., 0.2)
PUBLIC_KILN_FHIR_BASE_URL           # Base for Bundle.entry.fullUrl (e.g., https://kiln.fhir.me)
PUBLIC_KILN_VALIDATION_SERVICES_URL # Base URL for /validate and /tx ('' for same-origin)
PUBLIC_KILN_FHIR_GEN_CONCURRENCY    # Parallel FHIR generation (e.g., 1)
# PUBLIC_KILN_API_KEY               # Not exposed via runtime endpoint; do not embed in builds
```

Client-side LocalStorage keys (override defaults in the browser):

```
TASK_DEFAULT_BASE_URL
TASK_DEFAULT_API_KEY
TASK_DEFAULT_MODEL
TASK_DEFAULT_TEMPERATURE
FHIR_BASE_URL
VALIDATION_SERVICES_URL
FHIR_GEN_CONCURRENCY
```

Notes:
- Security: API keys are never embedded in static assets, and the runtime `/api/config/defaults` endpoint excludes `PUBLIC_KILN_API_KEY`. Provide the key via the UI or browser storage.
- Same-origin validation: Leave `VALIDATION_SERVICES_URL` blank to call the server’s own `/validate` and `/tx` endpoints.
- Diagnostics: The Settings modal prints any build/runtime defaults (from `window.DEFAULT_VALUES`) to help confirm the effective configuration.

Example development env file (`.env.local`):

```
PUBLIC_KILN_BASE_URL=https://openrouter.ai/api/v1
PUBLIC_KILN_MODEL=openai/gpt-4
PUBLIC_KILN_TEMPERATURE=0.7
PUBLIC_KILN_FHIR_BASE_URL=https://kiln.fhir.me
PUBLIC_KILN_VALIDATION_SERVICES_URL=http://localhost:3500
PUBLIC_KILN_FHIR_GEN_CONCURRENCY=3
```

Run with your env loaded (or export vars in your shell):

```
# Example: pass an env file to Bun
bun --env-file .env.local run dev
```

### Docker (Alternative)
For a containerized setup with all dependencies pre-installed:

1. **Build the Image:**
   ```
   docker build -t kiln .
   ```
   This creates an image with Bun, Java, validator JAR, and pre-loaded terminology (SQLite in `/app/server/db/terminology.sqlite`).

2. **Run the Container:**
   ```
   docker run -p 3500:3500 -v ./server/db:/app/server/db kiln
   ```
   Access the full app at `http://localhost:3500` (UI + APIs). For persistence, the volume mounts the local `./server/db` directory.

3. **Advanced Docker Usage:**
   - Override env vars: `docker run -p 3500:3500 -e PORT=8080 -e VALIDATOR_HEAP=8g kiln`.
   - Multi-container: Run the server with `docker run -p 3500:3500 kiln` and access via `http://localhost:3500`.

If you encounter issues (e.g., Java heap exhaustion), check container logs with `docker logs <container-id>` and adjust `VALIDATOR_HEAP`.

```
git clone repo
│
├─ bun install (root)
│
├─ cd server
│ ├─ bun install
│ ├─ bun run setup.ts (downloads validator + vocab)
│ └─ bun run scripts/load-terminology.ts (populates DB)
│
└─ bun run dev (starts UI + APIs on port 3000)
```

## 4. Usage

Kiln provides both an intuitive browser interface for interactive use and a set of RESTful APIs for programmatic access. The UI handles the full workflow from sketch to FHIR, while the APIs enable custom integrations, such as embedding terminology lookup in other tools or validating generated resources.

### Running the App
Kiln runs as a single-process server combining the UI and APIs, powered by Bun for fast hot-reloading during development.

- **Full Dev Server (UI + APIs):** Run `bun run dev` from the project root. This starts the app on http://localhost:3000, serving the browser UI with all APIs mounted. Changes to code or assets trigger automatic reloads.
- **APIs Only:** For headless use, navigate to the `./server` directory and run `bun run dev`. The server listens on http://localhost:3500, exposing endpoints without the UI. Ideal for testing or integrating with external clients.
- **Production Deployment:** Build static assets with `bun run build:static` (outputs to `./dist`), then deploy the server via your platform. Bun supports serverless environments like Vercel or Cloudflare Workers with minimal configuration. Use Docker for containerized deployment: `docker build -t kiln . && docker run -p 3500:3500 kiln`.

Monitor logs for startup messages; the server will indicate when the validator and terminology services are ready.

### UI Workflow
The browser interface offers a streamlined experience for generating and refining clinical content. Access it at http://localhost:3000 after starting the dev server.

1. **Enter Patient Sketch:** In the header bar, type a brief description (e.g., "52F with chest pain, onset 2 weeks ago, no known allergies"). Click "Start" to initiate generation. Optionally, check "Also generate FHIR Bundle" for automatic conversion.
2. **Generate Narrative:** Review the LLM-generated outline in the dashboard. Approve or revise sections (e.g., HPI, Physical Exam) via the artifacts table. Use the critique loop to iterate on drafts until satisfied—scores indicate quality (e.g., >0.75 for approval).
3. **Convert to FHIR:** Once the narrative is finalized (look for the "ReleaseCandidate" artifact), select "Convert to FHIR" from the job sidebar or header. This extracts sections, generates resources, and produces an IPS-compliant Bundle.
4. **View and Manage Artifacts:** The dashboard shows a timeline or table of outputs (notes, outlines, bundles). Click artifacts to inspect details, including validation issues. Use the "Rerun" button to regenerate with tweaks, or "Clear Cache" to reset specific phases.

The sidebar lists all jobs (narratives or FHIR conversions); select one to view its progress and artifacts. For chaining, complete a narrative first, then create a new FHIR job referencing it.

### API Endpoints
Kiln's APIs provide low-level access to core services. All endpoints support JSON requests/responses and CORS (default: allow all origins). Base URL: http://localhost:3500 (or your configured port).

- **Terminology Search:** `POST /tx/search`
  - **Purpose:** Find codes across SNOMED CT, LOINC, RxNorm, and FHIR systems.
  - **Request Body:** `{ "queries": ["diabetes"], "systems": ["http://snomed.info/sct"], "limit": 20 }`.
  - **Response:** `{ "results": [{ "query": "diabetes", "hits": [{ "system": "...", "code": "...", "display": "..." }], "count": N }] }`.
  - **Example:** Search for "chest pain" to get SNOMED codes for integration into your app.

- **Code Existence Check:** `POST /tx/codes/exists`
  - **Purpose:** Verify if specific codes exist in the terminology database.
  - **Request Body:** `{ "items": [{ "system": "http://loinc.org", "code": "2345-7" }] }`.
  - **Response:** `{ "results": [{ "system": "...", "code": "...", "exists": true, "display": "..." }] }`.
  - **Example:** Check LOINC glucose code before using it in an Observation.

- **FHIR Validation:** `POST /validate`
  - **Purpose:** Validate a single FHIR resource against R4/IPS.
  - **Request Body:** `{ "resource": { "resourceType": "Patient", ... }, "profile": "http://hl7.org/fhir/StructureDefinition/Patient" }`.
  - **Response:** `{ "valid": true, "issues": [] }` or `{ "valid": false, "issues": [{ "severity": "error", "details": "..." }] }`.
  - **Example:** Send a generated Bundle to check conformance.

- **Health Check:** `GET /health`
  - **Purpose:** Verify server status.
  - **Response:** `{ "status": "ok", "services": { "terminology": true, "validator": { "ready": true } } }`.
  - **Example:** Use in monitoring or before API calls.

For batch validation, use `POST /validate/batch` with `{ "resources": [{ "id": "p1", "resource": {...} }] }`. All endpoints return JSON with CORS headers enabled.


### Example: Generate from Sketch
To create a full document from a sketch:

- **Via UI:** 
  1. Start the server: `bun run dev`.
  2. At http://localhost:3000, enter "52F with chest pain, onset 2 weeks ago" in the header.
  3. Click "Start" to generate the narrative (review outline and sections).
  4. Once approved, click "Convert to FHIR" to create the Bundle.
  5. View artifacts in the dashboard; download or validate the JSON.

- **Via API (Programmatic):**
  1. Use `/tx/search` to find terms: `curl -X POST http://localhost:3500/tx/search -d '{"queries": ["chest pain"]}'`.
  2. Generate via UI or implement LLM calls mirroring `./src/workflows`.
  3. Validate the Bundle: `curl -X POST http://localhost:3500/validate -d '{"resource": { ... }}'`.

This produces a narrative note and FHIR Bundle with validated resources (e.g., Condition for chest pain, Observation for vitals).

```mermaid
graph LR
    A[Client] -->|POST /tx/search<br/>{queries: ["chest pain"]}| B[Terminology Service]
    B --> C[SNOMED/LOINC/RxNorm<br/>Results]
    A -->|POST /validate<br/>{resource: Bundle}| D[FHIR Validator]
    D --> E[Issues or Valid]
```

## 5. Architecture

Kiln's architecture is designed for simplicity and performance, leveraging Bun as a unified runtime for both the frontend and backend while integrating external services for specialized tasks like FHIR validation. The system avoids traditional Node.js dependencies, using TypeScript throughout for type safety and maintainability. It runs as a single-process server in development (with hot-reloading) and supports containerized deployment for production.

### Stack
Kiln uses a modern, lightweight stack optimized for rapid iteration and low overhead:

- **Runtime:** Bun (fast JavaScript/TypeScript runtime with built-in bundling and server capabilities). No Node.js is used; Bun handles HTTP serving, SQLite access, and script execution directly.
- **UI:** React (version 19+) for the browser interface, with hooks for state management (e.g., IndexedDB stores) and components for workflows and artifact viewing. Development mode includes no-build hot-reloading via Bun's plugin system.
- **Backend:** A single Bun-based server that proxies the UI and exposes RESTful APIs. It manages workflows, terminology lookups, and validation requests without a separate backend framework.
- **Storage:** SQLite for the terminology database (`./server/db/terminology.sqlite`), using FTS5 for efficient full-text search across designations. No external database server is required; the DB is pre-populated with LOINC, SNOMED CT, RxNorm, and FHIR code systems.
- **External Services:**
  - **FHIR Validator:** HAPI FHIR validator (Java-based, runs as a spawned process on port 8080). Integrated via HTTP calls for structure and profile checks.
  - **LLM Provider:** External API (e.g., OpenRouter) for generation tasks. Configurable via environment variables; no local model hosting.

This stack ensures fast startup (under 10 seconds locally) and low resource use, with the SQLite DB providing offline-capable terminology search.

### Directory Structure
The monorepo is organized for clear separation of concerns, with the server and UI sharing the same Bun runtime for seamless development:

- **`./src`:** Core application source code.
  - **UI Components:** React components for the dashboard, artifact viewer, input forms, and job management.
  - **Hooks:** Custom React hooks (e.g., `useDashboardState` for state synchronization, `useJobsList` for sidebar).
  - **Workflows:** LLM-driven pipelines (`./src/workflows`) for narrative synthesis and FHIR generation.
  - **Services:** Utilities for FHIR operations (`./src/services`), including bundle assembly and resource refinement.
  - **Stores:** IndexedDB wrappers (`./src/stores`) for managing app state like jobs and artifacts.
  - **Types:** Shared TypeScript interfaces (e.g., `Context`, `Artifact`) for type safety across UI and workflows.

- **`./server`:** API server and backend services.
  - **Source (`./server/src`):** TypeScript modules for API routes (`./server/src/api.ts`), terminology search (`./server/src/services/terminology.ts`), and validation (`./server/src/services/validator.ts`).
  - **Database (`./server/db`):** SQLite file (`terminology.sqlite`) with FTS5 indexes for fast lookups.
  - **Vocabularies (`./server/large-vocabularies`):** Cached NDJSON files for LOINC, SNOMED CT, RxNorm, and FHIR code systems, loaded via `./server/scripts/load-terminology.ts`.
  - **Scripts (`./server/scripts`):** Setup (`setup.ts`) and data loading (`load-terminology.ts`).

- **`./public`:** Static assets served directly by Bun (e.g., logo, CSS, favicon).

- **`./scripts`:** Utility scripts for building static assets (`build-static.ts`) and other tasks.

- **Root Files:** `package.json` (Bun dependencies), `tsconfig.json` (TypeScript config), `index.html` (entry point for UI).

This structure allows independent development: edit UI in `./src` with hot reloads, or focus on APIs in `./server` without rebuilding.

### Key Modules
Kiln's modularity enables easy extension, with clear responsibilities for each component:

- **Workflows (`./src/workflows`):** Core LLM-driven generation logic. Separate phases for narrative (e.g., `buildNarrativeWorkflow` in `./src/workflows/narrative/index.ts`) and FHIR conversion (`buildFhirWorkflow` in `./src/workflows/fhir/index.ts`). Each workflow is an array of functions (`DocumentWorkflow<FhirInputs>`), executing steps like outline creation, section drafting, and bundle assembly. Prompts are defined in subdirectories (e.g., `./src/workflows/fhir/prompts.ts`).

- **Services (`./src/services`):** Reusable utilities for FHIR operations.
  - **FHIR Generation (`./src/services/fhirGeneration.ts`):** Handles resource creation and refinement, including terminology searches and patch application.
  - **Artifacts (`./src/services/artifacts.ts`):** Helpers for emitting JSON artifacts with metadata (e.g., `emitJsonArtifact`).
  - **Coding Analysis (`./src/codingAnalysis.ts`):** Scans resources for unresolved codings and applies extensions.

- **Stores (`./src/stores`):** Browser-side state management using IndexedDB.
  - **Dashboard Store (`./src/dashboardStore.ts`):** Manages job views, artifacts, and events with subscription patterns for reactive UI updates.
  - **Job Store:** Tracks workflows, steps, and dependencies (e.g., narrative to FHIR chaining).

- **UI (`./src/components`):** React-based interface.
  - **Dashboard (`./src/components/DocGenDashboard.tsx`):** Central view for jobs, artifacts, and progress.
  - **Artifact Viewer (`./src/components/ArtifactDetails.tsx`):** Inspects notes, bundles, and validation reports.
  - **Input Forms (`./src/components/documents`):** Type-specific UIs (e.g., `NarrativeInputForm.tsx` for sketches).
  - **UI Utilities (`./src/components/ui`):** Shared components like badges, cards, and progress bars.

### Data Flow
Data moves through Kiln in a directed acyclic graph (DAG) of artifacts and steps, ensuring traceability:

1. **Input:** User enters a sketch via UI or API.
2. **LLM Prompts:** Workflow phases trigger LLM calls (e.g., outline generation in `planningPhase`), producing artifacts like briefs and drafts stored in IndexedDB.
3. **Artifact Creation:** Each step outputs typed artifacts (e.g., `SectionDraft`, `FhirResource`) with metadata (phase, version, tags) and links to prior steps.
4. **Validation:** Generated FHIR resources are checked via `/validate` API; issues (e.g., invalid codes) are annotated as extensions and fed back for refinement.
5. **Output:** Final artifacts (narrative MD, FHIR JSON) are viewable/exportable; bundles include fullUrl references for interoperability.

The flow is fault-tolerant: narrative generation proceeds even if FHIR fails, with placeholders for unresolved elements.

```mermaid
graph TB
    UI[React UI<br/>(Bun dev server)] -->|HTTP| API[Bun API Server<br/>(port 3500)]
    API --> DB[SQLite<br/>(Terminology)]
    API --> VLD[Java Validator<br/>(port 8080)]
    UI --> LLM[External LLM<br/>(OpenRouter)]
    LLM -->|Prompts| WF[Workflow Engine<br/>(LLM Tasks)]
    WF -->|Artifacts| UI
    DB -->|Search/Exists| API
    VLD -->|Validate| API
    classDef ui fill:#e1f5fe
    classDef api fill:#f3e5f5
    classDef ext fill:#fff3e0
    class UI,WF ui
    class API api
    class DB,VLD ext
```

This architecture supports both interactive use and API-driven automation, with clear extension points for new workflows or vocabularies.

## 6. Development

Kiln is designed for easy contribution, with a focus on rapid iteration and clear extension points. The codebase uses TypeScript for type safety, Bun for the runtime, and a modular structure to separate UI, workflows, and services. Contributors can extend functionality by adding new workflows, vocabularies, or custom prompts while maintaining the existing architecture.

### Local Development
Kiln supports hot-reloading for both the UI and API, making it straightforward to test changes as you code. The development server watches for updates to TypeScript, JavaScript, CSS, and Markdown files, rebuilding and refreshing automatically.

- **Hot Reload:** Run `bun run dev` from the project root to start the full server (UI on port 3000, APIs on 3500). Edits to `./src` trigger UI reloads, while changes to `./server/src` restart the API. Use the browser dev tools to inspect React components and network calls to the LLM or validator.
- **Test:** Execute `bun test` to run unit and integration tests. Coverage includes workflow phases, API endpoints, and UI interactions. Tests use Bun's built-in test runner with mocks for external services (e.g., LLM responses). Run specific suites like `bun test terminology` for focused debugging.
- **Lint:** Use `bun run format` to auto-format with Prettier (handles TS/JS/JSON/MD/YAML). Check compliance with `bun run format:check`. ESLint is not enforced but can be added via `bun add -D eslint`.
- **Build:** Generate production-ready static assets with `bun run build:static`. This bundles the UI into `./dist` (HTML/JS/CSS) while preserving the server. Deploy the output to any static host (e.g., Vercel, Netlify) or use the Docker image for the full stack.

For debugging, enable Bun's verbose logging with `BUN_DEBUG=1 bun run dev` to trace API calls, or use `console.log` in workflows for step-by-step inspection.

### Adding Vocabularies
Extending Kiln's terminology coverage is straightforward, as it supports NDJSON.gz files for code systems. This format allows efficient loading of large vocabularies without complex ETL.

- **Prepare Vocabulary:** Obtain or generate an NDJSON.gz file in FHIR CodeSystem format (first line: CodeSystem resource; subsequent lines: individual concepts with `code`, `display`, and optional `designation`/`property` arrays). Place it in `./server/large-vocabularies` (e.g., `CodeSystem-myvocab-v1.0.ndjson.gz`).
- **Ingest Data:** Run `bun run scripts/load-terminology.ts` from the `./server` directory. This scans for new files, parses them, and populates the SQLite database with concepts and designations. The script handles deduplication and creates FTS5 indexes for search.
- **Update System Recognition:** If the vocabulary uses a new system URL, add it to `SYSTEM_URLS` in `./server/scripts/load-terminology.ts` (e.g., `myvocab: 'http://example.com/myvocab'`). Re-run the loader to include it in searches.
- **Verify:** Restart the server and test via UI (search for a known code) or API (`POST /tx/search { "queries": ["term"], "systems": ["http://example.com/myvocab"] }`). Check `./server/db/terminology.sqlite` for loaded rows.

Vocabularies are loaded on startup or via the script, with automatic optimization (e.g., FTS5 for fuzzy matching). For large imports (>100k concepts), monitor Java heap usage and consider batching.

### Customizing Workflows
Kiln's workflows are modular arrays of phases, making it easy to add new document types or modify generation logic.

- **Edit Workflows:** Modify existing phases in `./src/workflows` (e.g., `./src/workflows/fhir/index.ts` for FHIR generation). Each phase is a function array (e.g., `definePhase('Planning', { phase: 'planning' }, [task1, task2])`), allowing sequential or parallel steps. Update prompts in subdirectories like `./src/workflows/fhir/prompts.ts`.
- **Add Document Types:** Register new types in `./src/documentTypes/registry.ts` (e.g., `registry.register('lab-report', { buildWorkflow: labWorkflow })`). Create corresponding input forms (`./src/components/documents/LabInputForm.tsx`) and workflows (`./src/workflows/lab-report.ts`). The UI will auto-detect via `registry.all()`.
- **Test Changes:** Use `bun test` for unit tests on workflows (e.g., mock LLM responses). In the UI, enable `forceRecompute: true` in job inputs (via dev tools) to re-run phases without cache. Debug with the dashboard's step viewer, which shows prompts, outputs, and validation traces.

Workflows are typed with `DocumentWorkflow<T>` for inputs (e.g., `FhirInputs`), ensuring compatibility with the UI and stores.

### Debugging
Kiln provides multiple entry points for troubleshooting, from UI inspection to API traces.

- **LLM Prompts:** Artifacts in the dashboard (e.g., "Outline v1") include raw prompts and responses. Click to view the full LLM input/output, including guidance like IPS notes. For custom debugging, log prompts in workflows (e.g., `console.log('Prompt:', params)` in `./src/workflows/narrative/index.ts`).
- **Validation:** Use the UI's artifact viewer to see issues (e.g., unresolved codings as extensions) or call `/validate` directly: `curl -X POST http://localhost:3500/validate -d '{"resource": { ... }}'`. Check server logs for Java validator output (e.g., code mismatches).
- **Logs:** Bun's console shows API requests, LLM calls, and errors. For verbose mode, set `BUN_DEBUG=1` or add `console.log` in services (e.g., `./src/services/fhirGeneration.ts`). Use the dashboard's events panel for real-time workflow traces.

For performance issues, profile with Bun's built-in tools (`bun --inspect`) or monitor SQLite queries in the terminology service.

```
Code Change → bun run dev → Hot Reload (UI + API)
                ↓
             bun test → Coverage Report
                ↓
         bun run build:static → ./dist (deployable)
```

## 7. License

Kiln is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.

### Attribution
Kiln is written by Josh Mandel, MD. It incorporates the HAPI FHIR validator (Apache 2.0 license) for structure and conformance checks. Vocabularies (LOINC, SNOMED CT, RxNorm) are sourced from public repositories under their respective licenses (e.g., LOINC under LOINC® License; SNOMED CT under IHTSDO terms). See individual files in `./server/large-vocabularies` for details.

### Dependencies
- **Bun**: MIT License (runtime and package manager).
- **React**: MIT License (UI framework).
- **HAPI FHIR Validator**: Apache 2.0 License (Java-based validation server).
- **SQLite**: Public Domain (database engine).
- **Prettier**: MIT License (code formatting).

All dependencies are included in `package.json` and follow their respective licenses. No proprietary or restrictive licenses are used in the core codebase.
