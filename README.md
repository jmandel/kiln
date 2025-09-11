# Kiln

## Overview

Kiln is a sophisticated, browser-based framework for orchestrating multi-step AI-driven workflows. It excels at complex generative tasks, such as transforming a simple patient sketch (e.g., "52F with chest pain") into a detailed clinical narrative and then converting that narrative into a standards-compliant FHIR document bundle. The engine decomposes workflows into granular, observable steps, ensuring transparency, debuggability, and resilience.

Key features include:
- **Step-by-Step Execution**: Workflows are broken into atomic steps (e.g., planning, drafting, validation) that can be cached, replayed, or resumed.
- **Rich Observability**: Visualize execution graphs, timelines, artifacts, and dependencies in real-time.
- **LLM Integration**: Seamless integration with OpenAI-compatible APIs for text generation and decision-making.
- **FHIR Compliance**: Built-in support for generating and validating FHIR resources, with terminology resolution and coding checks.
- **Persistence**: All state (steps, artifacts, links) is stored in the browser's IndexedDB (with LocalStorage fallback) for durability across sessions.
- **Extensibility**: Easily define new workflows by composing phases and tasks in TypeScript.

This project demonstrates a full pipeline for clinical documentation: from narrative synthesis to structured FHIR export, making it ideal for healthcare AI applications.

## How Generation Works

Kiln's workflow for generating clinical narratives and FHIR documents follows a structured, iterative pipeline. The approach emphasizes **granular decomposition** (breaking tasks into small, cacheable steps), **iterative refinement** (draft → critique → approve/rewrite loops), and **standards compliance** (FHIR validation with terminology resolution). This ensures high-quality outputs while allowing precise debugging and resumption.

The current workflow (`buildDocumentWorkflow` in `src/workflows.ts`) consists of six main phases, executed sequentially. Each phase uses the LLM (via `ctx.callLLM()`) for creative and analytical tasks, with built-in caching to avoid re-execution of unchanged steps. The pipeline is designed to be realistic and evidence-based, drawing from clinical documentation best practices.

### 1. Planning Phase
   - **Goal**: Create a high-level structure for the narrative.
   - **Approach**: The LLM generates a JSON outline from the patient sketch. It infers demographics, history, symptoms, and risks, producing sections (e.g., Chief Complaint, History of Present Illness, Assessment, Plan) with brief guiding descriptions. This outline acts as a "contract" for subsequent phases.
   - **Key Steps**:
     - `plan_outline`: LLM prompt to synthesize an outline.
     - Realize briefs: Extract section briefs from the outline and store as artifacts.
   - **Artifacts**: `NarrativeOutline` (JSON), `SectionBrief` (per-section JSON).
   - **Rationale**: A structured plan prevents drift in later drafting and ensures logical flow.

### 2. Sections Phase
   - **Goal**: Draft detailed content for each section of the note.
   - **Approach**: For each outline section (up to 8 sections), iteratively generate prose using the sketch, prior sections (for context), and the section brief. Each draft is critiqued for realism, consistency, and clinical accuracy. Scores determine approval (e.g., ≥0.75 approves; below triggers rewrite or pause for human review). Up to 3 revisions per section.
   - **Key Steps** (per section):
     - `draft_section`: Generate initial text.
     - `critique_section`: LLM evaluates quality (0-1 score).
     - `decide_section`: Approve/rewrite based on score vs. threshold (e.g., 0.75).
   - **Artifacts**: `SectionDraft` (text, versioned), `SectionCritique` (JSON feedback), `Decision` (JSON approve/rewrite).
   - **Rationale**: Iterative loops refine outputs iteratively, mimicking human editing. Pauses allow manual intervention for sensitive clinical content.

### 3. Assembly Phase
   - **Goal**: Combine sections into a cohesive narrative.
   - **Approach**: The LLM assembles approved section drafts into a full Markdown note, adding transitions and ensuring narrative flow. A single draft is produced here, as assembly is less iterative.
   - **Key Steps**:
     - `assemble_note`: Stitch sections with summaries for context.
   - **Artifacts**: `NoteDraft` v1 (Markdown text).
   - **Rationale**: Ensures the note reads as a unified document, not disjointed sections.

### 4. Note Review Phase
   - **Goal**: Refine the full note for overall quality.
   - **Approach**: Similar to sections, but at the document level. Assemble → critique → decide (up to 3 revisions). Critiques focus on coherence, completeness, and clinical tone. Low scores trigger rewrites.
   - **Key Steps**:
     - `draft_note`: Initial assembly (if needed).
     - `critique_note`: Evaluate the full note.
     - `decide_note`: Approve or rewrite.
     - `rewrite_note`: Revise based on critique (if needed).
   - **Artifacts**: `NoteDraft` (revised versions), `NoteCritique` (JSON), `NoteDecision` (JSON).
   - **Rationale**: Catches issues like inconsistencies across sections. Final approval ensures the narrative is polished.

### 5. Finalized Phase
   - **Goal**: Produce a release-ready narrative.
   - **Approach**: A final LLM pass polishes the approved note for grammar, clarity, and professional tone. No further iterations here.
   - **Key Steps**:
     - `finalize_note`: Minor edits and formatting.
   - **Artifacts**: `ReleaseCandidate` v1 (final Markdown text).
   - **Rationale**: Ensures the narrative is publication-ready before FHIR conversion.

### 6. FHIR Encoding Phase
   - **Goal**: Transform the narrative into a structured FHIR Bundle.
   - **Approach**: Parse the Markdown note to extract sections and key entities (e.g., symptoms, medications). Generate a FHIR `Composition` plan, then parallel-generate resources (e.g., `Condition` for problems, `Observation` for vitals). Each resource is iteratively refined via LLM to fix validation errors and resolve terminology (e.g., search for "chest pain" → SNOMED code). Finally, assemble into a `Bundle` and validate.
   - **Key Steps**:
     - `fhir_composition_plan`: Create Composition with section narratives and resource placeholders.
     - `fhir_generate_resource`: Parallel generation of individual resources (e.g., Patient, Encounter, Condition).
     - `fhir_resource_validate_refine`: Iterative refinement (up to 12 iterations): Analyze codings, validate, LLM proposes patches, filter/apply.
     - `analyze_codings`: Pre/post-recoding reports for terminology issues.
     - `finalize_unresolved`: Add extensions for unresolved codings.
     - Bundle assembly and final validation.
   - **Artifacts**: `FhirCompositionPlan`, `FhirResource` (generated/refined), `CodingValidationReport`, `ValidationReport`, `FhirBundle` (final output).
   - **Rationale**: Ensures FHIR compliance via validation loops and terminology search. Parallel generation scales for complex documents.

### Overall Approach to Generations
- **LLM-Driven**: All creative and analytical tasks use LLM calls, with prompts optimized for the task (e.g., structured JSON for plans, free-text for narratives).
- **Caching & Resumption**: Steps are cached by input hash (e.g., prompt SHA-256). Re-runs skip completed steps, resuming from failures.
- **Quality Gates**: Thresholds (e.g., score ≥0.75) trigger pauses for human review, balancing automation with safety.
- **Traceability**: Every step produces artifacts and links, enabling full data lineage (e.g., which LLM call generated a FHIR resource).
- **Standards Integration**: FHIR generation includes UCUM units, canonical coding (SNOMED/LOINC/RxNorm), and validation against R4 profiles.
- **Error Resilience**: Failures are isolated; the pipeline continues where possible, with detailed traces.

This phased, iterative approach produces high-fidelity outputs while maintaining clinical accuracy and allowing human oversight.

## Architecture

The system is modular and layered:

- **Engine (`src/engine.ts`)**: Core runtime for executing workflows. Manages `Context` objects, step caching, error handling, and resumption. Key primitives: `step()` for tracked operations, `callLLM()` for AI calls, `createArtifact()` for outputs, and `link()` for dependencies.

- **Workflows (`src/workflows.ts`)**: Defines pipelines like `buildDocumentWorkflow()`, which sequences phases (e.g., planning, section drafting, FHIR encoding). Phases are functions that receive the `Context` and execute tasks.

- **Stores (`src/stores.*.ts`)**: Abstracts persistence using IndexedDB (primary) or LocalStorage (fallback). Stores documents, workflows, steps, artifacts, and links.

- **Prompts (`src/prompts.ts`)**: Centralized LLM prompts for tasks like outline generation, section drafting, and FHIR validation. Prompts are templated functions for easy management.

- **Services (`src/services/`)**: Specialized logic for FHIR generation, artifact emission, and validation.

- **UI (`src/components/`)**: React-based interface with dashboard, artifact viewers, step details, and workflow controls.

- **Server (`server/`)**: A Bun-based backend for FHIR terminology search (`/tx/search`) and validation (`/validate`). Includes SQLite database for terminology and Java-based FHIR validator.

- **Types (`src/types.ts`)**: Comprehensive TypeScript definitions for all entities (e.g., `Artifact`, `Step`, `Context`).

The engine ensures workflows are **resumable**: Failed or pending steps can be re-run individually, and the system auto-resumes on page reload.

## Quick Start

### Prerequisites

- **Bun**: Install from [bun.sh](https://bun.sh) (Node.js alternative for faster builds).
- **Git**: Required for cloning and submodules.
- **Java 11+**: Needed for the FHIR validator in the server.
- **Browser**: Modern browser with IndexedDB support (e.g., Chrome, Firefox).

### Clone and Install

1. Clone the repository:
   ```bash
   git clone <repo-url> kiln
   cd kiln
   ```

2. Install frontend dependencies:
   ```bash
   bun install
   ```

3. Set up the server (in `server/` directory):
   ```bash
   cd server
   bun install  # Install Bun dependencies
   bun run setup  # Download FHIR validator JAR and set up large-vocabularies submodule
   ```

   The `setup` script:
   - Downloads the latest FHIR validator JAR from HL7.
   - Initializes the `large-vocabularies` Git submodule (contains LOINC, SNOMED CT, RxNorm NDJSON files).
   - Creates the `db/` directory for the SQLite terminology database.

### Set Up Vocabularies

The server requires a terminology database for code resolution during FHIR generation. Run the loader script to populate it:

```bash
cd server  # If not already in server/
bun run load-terminology  # Loads LOINC, SNOMED CT, RxNorm, FHIR valuesets, and UTG
```

This script:
- Scans `./large-vocabularies` for NDJSON files (e.g., `CodeSystem-snomed.ndjson.gz`).
- Loads the latest versions of key vocabularies (LOINC, SNOMED CT, RxNorm).
- Downloads and processes FHIR R4 valuesets and UTG (Unified Terminology Governance) CodeSystems.
- Builds optimized indexes for fast searches.
- Outputs a summary of loaded systems and concept counts.

Expected output:
```
📦 Step 1: Loading large vocabularies...
✅ Loaded 123456 concepts from http://loinc.org
✅ Loaded 789012 concepts from http://snomed.info/sct
✅ Loaded 456789 concepts from http://www.nlm.nih.gov/research/umls/rxnorm

📦 Step 2: Loading FHIR R4 valuesets...
✅ Loaded 50 FHIR code systems with 25000 concepts

📦 Step 3: Loading UTG codesystems...
✅ Loaded 100 UTG code systems with 50000 concepts

🔧 Step 4: Optimizing database...

📊 Summary:
  • Code Systems: 152
  • Total Concepts: 1,234,567
  • Total Designations: 2,345,678
```

The database is saved to `./server/db/terminology.sqlite`. If you update vocabularies, re-run `bun run load-terminology` to refresh.

### Run the Project

1. Start the development server (from project root):
   ```bash
   bun dev
   ```

   This runs a single Bun server that serves:
   - **UI**: Static HTML/JS/CSS at `http://localhost:3000` (or the assigned port).
   - **API**: FHIR terminology (`/tx/*`) and validation (`/validate/*`) endpoints at the same origin.
   - The server auto-reloads on code changes for hot development.

   Output:
   ```
   ✅ Dev server (UI + API mounted) at http://localhost:3000
   ```

2. Open the app in your browser: Visit `http://localhost:3000`.

3. Configure LLM Access:
   - Click the settings gear icon.
   - Set your API base URL (e.g., `https://openrouter.ai/api/v1`).
   - Enter an API key (e.g., from OpenRouter.ai).
   - Optionally, set FHIR base URL (e.g., `https://kiln.fhir.me`) for Bundle references.

4. Create and Run a Workflow:
   - Enter a patient sketch (e.g., "52F with chest pain").
   - Click "Create Job" to start the narrative generation.
   - Monitor progress in the dashboard (steps, artifacts, events).
   - View generated FHIR resources and validation reports.

### Development Workflow

- **Hot Reload**: The `bun dev` command watches for changes and reloads the server automatically.
- **Tests**: Run `bun test` in root (frontend) or `bun test` in `server/` (backend).
- **Vocab Updates**: Re-run `server/scripts/load-terminology.ts` after pulling submodule updates.
- **Custom Ports**: Set `PORT` env var for a different port (default: 3000).

## Key Concepts

### Workflows and Phases

Workflows are arrays of phases. Each phase is a function that receives a `Context` object (`ctx`):

- **Steps (`ctx.step(key, fn, opts)`)**: Atomic operations. Cached if `key` matches a prior successful run.
- **LLM Calls (`ctx.callLLM(task, prompt, opts)`)**: High-level AI invocations. Prompts are defined in `src/prompts.ts`.
- **Artifacts (`ctx.createArtifact(...)`)**: Versioned outputs (e.g., JSON plans, text drafts, FHIR bundles).
- **Links (`ctx.link(from, role, to)`)**: Trace dependencies (e.g., step "produced" artifact).

Example phase:
```typescript
const planningPhase = async (ctx: Context) => {
  await ctx.step('plan_outline', async () => {
    // LLM call or computation
  }, { title: 'Generate Outline' });
};
```

### Data Model

- **Document**: High-level job (title, sketch, status).
- **Workflow**: Execution instance for a document.
- **Step**: Tracked operation (status, result, duration, tokens).
- **Artifact**: Output from a step (e.g., narrative text, FHIR JSON).
- **Link**: Directed edge (e.g., step → artifact via "produced").

All are persisted and visualized.

## Extending the System

### Adding a New Workflow

1. Define phases in `src/workflows.ts` (e.g., `buildNewWorkflow(input)` returns phase array).
2. Register it (e.g., in `src/workflows.ts` export).
3. Add a UI trigger (e.g., button in `src/components/DocGenApp.tsx`).

### Customizing Prompts

- Edit `src/prompts.ts` to refine LLM behavior.
- Prompts are templated (e.g., `({ sketch }) => \`...${sketch}...\``).

### LLM Configuration

- Supports OpenAI-compatible endpoints (OpenRouter.ai default).
- Set API key and model in app settings.
- Temperature controls creativity (default: 0.2 for structured tasks).

## Troubleshooting

- **No Terminology Results**: Ensure `bun run load-terminology` completed successfully. Check `./server/db/terminology.sqlite`.
- **Validator Errors**: Verify Java 11+ is installed. Check server logs for Java issues.
- **Workflow Stuck**: Use "Clear Cache" in the dashboard to re-run steps.
- **API Key Issues**: Confirm your LLM provider key is valid and has quota.
- **LocalStorage Full**: Switch to IndexedDB (automatic fallback) or clear browser storage.

## Contributing

- Fork and pull request to `main`.
- Run tests: `bun test`.
- Update vocabularies via server submodule.

## License

MIT License. See `LICENSE` for details.

For issues, file a GitHub issue with reproduction steps.
