// FHIR-specific prompt templates used by LLM tasks (restored to full guidance)

function safeScalar(v: any): string {
  try {
    if (v == null) return '';
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return String(v);
    // Prefer JSON to avoid [object Object]
    return JSON.stringify(v);
  } catch {
    try {
      return String(v);
    } catch {
      return '';
    }
  }
}

export const FHIR_PROMPTS = {
  // Composition planning prompt (restored wording)
  fhir_composition_plan: ({
    note_text,
    section_titles,
    subject_ref,
    encounter_ref,
    ips_notes,
    ips_example,
    prior_bundles,
  }: {
    note_text: string;
    section_titles?: string[];
    subject_ref?: string;
    encounter_ref?: string;
    ips_notes?: string[];
    ips_example?: string;
    prior_bundles?: Array<{ episodeNumber: number; bundle: any }>;
  }) => `You are an expert FHIR document architect. Given a clinical note, create a FHIR Composition resource that outlines the necessary sections and resources.

Prior episode bundles (use for continuity):
${
  prior_bundles && prior_bundles.length ?
    `<priorFhirBundles>${JSON.stringify(prior_bundles, null, 2)}</priorFhirBundles>

Continuity instructions:
- Reuse persistent identifiers (e.g., Patient, Encounter, ongoing MedicationRequest/MedicationStatement) from prior bundles when the same real-world entities continue.
- Generate new, unique resource ids for new clinical events in this episode (vitals, labs, new orders, updated assessments) so they do not collide with prior data.
- Avoid altering historical resources from prior episodes; represent changes with new resources and appropriate references.
`
  : '<priorFhirBundles />'
}

High-level goals:
- Represent results, orders, and performed actions with the correct resource types.
- Group related observations properly (e.g., panels) so downstream generation can produce a coherent, complete set.
- Keep individual Observations focused on a single measurable facet or assertion.

Physical exam guidance (important):
- Do NOT explode general physical exam narrative into many Observations. It is acceptable—and preferred—to keep most exam findings as plain text narrative in the appropriate Composition.section.text.
- Limit Observations to vital signs and clearly structured, measurable findings or standardized instruments (e.g., BP, HR, temperature, SpO₂, BMI, well-defined scores). Routine exam statements (e.g., “lungs clear to auscultation”, “no edema”) should remain in narrative unless explicitly required as a discrete, coded data point.

Social history and labs (important):
- Substance use (tobacco, alcohol) should be captured as structured data (e.g., Observation with appropriate codes for status/amount/frequency) when the note provides sufficient detail; use narrative for other social history items unless a standard instrument/scale is present.
- Laboratory results should be structured via DiagnosticReport + component Observations with appropriate LOINC codes; avoid creating Observations for loosely descriptive narrative that is not a result or measurable finding.

 Rules:
1) Create a \`Composition\`. If a list of section titles is provided, you MUST use exactly those section titles in the given order; do not invent, rename, remove, or reorder sections. Only populate \`entry\` arrays for each section.
   - Not every section needs discrete entries. For example, "Assessment" typically has no entries; it is narrative only. "Plan" may include a few orders (e.g., \`ServiceRequest\`) or medication orders (\`MedicationRequest\`) — keep this list small and essential.
   - You MUST set \`Composition.subject\` and \`Composition.encounter\` as Reference objects with a \`reference\` field, for example:
     • \`{"reference":"Patient/<some-id>"}\`
     • \`{"reference":"Encounter/<some-id>"}\`
     Include an informative \`display\` for each Reference to guide downstream synthesis:
      • For Patient, summarize salient demographics and context from the note (e.g., age, sex, any key identifiers or risk factors mentioned).
     • For Encounter, summarize the clinical setting and reason/context (e.g., inpatient vs outpatient, date/time if present, chief complaint/reason, service type).
     Use these same references consistently throughout related resources (e.g., Observation.subject, ServiceRequest.subject), so the document refers to a single patient and encounter.
   - Set \`Composition.author\` (array) with a Practitioner Reference, e.g., \`{"reference":"Practitioner/<some-id>"}\`. Include a concise \`display\` (name and role/title) derived from the note if available.
2) For each entity mentioned in the note, add a placeholder \`Reference\` in the appropriate section's \`entry\` array.
   - Diagnoses/conditions → \`Condition\`.
   - Med prescriptions → \`MedicationRequest\`; currently taking → \`MedicationStatement\` (or Administration if explicitly given during encounter).
   - Orders for tests/imaging/procedures → \`ServiceRequest\` (these are "orders", not results).
   - Performed procedures/interventions → \`Procedure\`.
   - Result reports (laboratory/imaging/other diagnostics) → \`DiagnosticReport\`.
   - Measurements/observations → \`Observation\` (primarily vitals and clearly structured measures; general physical exam findings should remain narrative).
3) Observations must be specific and single-facet:
   - Each Observation captures one measurable (e.g., LDL-C value, systolic BP) or one assertion (e.g., oxygen therapy used: true).
   - Use \`Observation.component\` only for a single logical observation with parts (e.g., blood pressure with systolic/diastolic). Do NOT put loosely related results in components.
4) If the note implies a panel or a set of member observations (e.g., "lipid panel", "CBC", "CMP"), include the whole set and preserve grouping order:
   - Create one \`DiagnosticReport\` for the panel (category 'laboratory') and separate \`Observation\`s for each analyte.
   - Optionally, include a panel \`Observation\` that uses \`hasMember\` to reference the analyte Observations (preferred for classic panel representation). If you include the panel Observation, also include the DiagnosticReport to summarize/report the results.
   - For imaging, prefer \`DiagnosticReport\` (category 'imaging') with result Observations for key measurements/findings. Include \`ImagingStudy\` only if the note supports it (e.g., modality/series details).
   - Ordering requirement (strict): In each section's \`entry[]\`, place the analyte \`Observation\` references immediately AFTER their parent \`DiagnosticReport\` reference so the group is contiguous and easy to follow.
5) Orders vs. results:
   - If the note says a test was ordered (no results yet) → \`ServiceRequest\` (place under Care Plan/Orders), not an \`Observation\`.
   - If the note reports results → \`DiagnosticReport\` with linked \`Observation\`(s) (place under Results/Measurements).
6) Placeholder content:
   - Each \`entry\` \`Reference\` MUST have:
     • \`reference\`: "<ResourceType>/<temp-id>" (e.g., "Observation/obs-ldl-1", "DiagnosticReport/report-lipid-1").
     • \`display\`: A concise instruction describing what to generate, including grouping relationships and key facets.
      For example, for a lipid panel: the \`DiagnosticReport\` display MUST explicitly list the analyte \`Observation\` IDs AND their plain‑language names, e.g., "Include Observation/obs-ldl-1 (LDL-C), Observation/obs-hdl-1 (HDL-C), Observation/obs-tg-1 (Triglycerides), Observation/obs-totalchol-1 (Total Cholesterol)". Each analyte \`Observation\` display should:
        • Name its analyte (with units if present), and
        • Refer back to the parent report ID (e.g., "result in DiagnosticReport/report-lipid-1").
7) Section narratives: For each section, set \`section.text.div\` to the template variable \`{{Section Title}}\` matching the source note header.
8) Top-level sections only (strict): Use ONLY the provided Required Section Titles (top-level H2 headers) for \`section[]\`. Do NOT create additional sections for subsections (e.g., headings like \`### Supportive Care\` under Plan). Keep all subsection content under the top-level section (e.g., "Plan").
9) Title and placeholder hygiene (strict): For each section with title S, set exactly \`"text": { "div": "<div>{{<title>}}</div>" }\`. Do not include Markdown markers (e.g., \`#\`) in titles or placeholders.
10) Conformance check before returning JSON:
   - Ensure \`section.length\` equals the number of Required Section Titles, titles are in the same order and match exactly, and every \`text.div\` equals \`"<div>{{<title>}}</div>"\`.
   - For every \`DiagnosticReport\` reference in \`section[*].entry[]\`, verify there is at least one analyte \`Observation\` reference with matching IDs listed immediately AFTER it in the same \`entry[]\` array, and that the \`DiagnosticReport\` display lists those IDs and names. If not, add the missing \`Observation\` entries and fix displays so IDs match exactly.

Clinical Note:
<note>
${note_text}
</note>

${
  section_titles && section_titles.length ?
    `
Required Section Titles (use EXACTLY these, in this order):
${section_titles.map((t) => `- ${t}`).join('\n')}
`
  : ''
}

${ips_notes && ips_notes.length ? `\nIPS Composition Guidance (shape & constraints):\n${ips_notes.map((n: string) => `- ${n}`).join('\n')}\n` : ''}

${ips_example ? `Example Composition shell (2-space pretty JSON; additional sections omitted for brevity):\n${ips_example}\n// ... etc (other sections follow this pattern)\n` : ''}

Return ONLY the FHIR Composition resource as a single JSON object. Do not include any other text or explanations.
The Composition must faithfully reflect the entire <note> content above while honoring the prior-bundle continuity guidance provided.`,

  // Resource generation prompt (restored wording)
  fhir_generate_resource: ({
    note_text,
    resource_reference,
    resource_description,
    subject_ref,
    encounter_ref,
    author_ref,
    ips_notes,
    ips_example,
  }: {
    note_text: string;
    resource_reference: string;
    resource_description: string;
    subject_ref?: string;
    encounter_ref?: string;
    author_ref?: string;
    ips_notes?: string[];
    ips_example?: string;
  }) => `You are an expert FHIR resource author. Given a full clinical note for context, and a specific instruction for a resource to create, generate a single, complete FHIR resource in JSON format.

Full Clinical Note (for context):
<note>
${note_text}
</note>

Resource to Generate:
- Target Type and ID: "${resource_reference}"
- Description: "${resource_description}"
${subject_ref ? `- Subject Reference to use (if applicable): "${subject_ref}"` : ''}
${encounter_ref ? `- Encounter Reference to use (if applicable): "${encounter_ref}"` : ''}
${author_ref ? `- Author/Practitioner Reference (if applicable): "${author_ref}"` : ''}

Generate the FHIR resource that matches the description and target type. Ensure the \`id\` matches the provided target reference.

Representation guidance (important):
- Observations: Keep each Observation focused on a single analyte/facet/assertion. Use \`component\` only when representing one logical measurement with parts (e.g., blood pressure). Prefer separate Observations for lab panel analytes. Use \`partOf\` to point child Observations to the parent panel Observation or DiagnosticReport when described.
- Observations (code selection): When a specific observation code exists for the single measurement, use that specific code rather than a panel code. Do not use panel Observation codes if a more specific measurement code is appropriate.
- DiagnosticReport: When description indicates a panel/report with multiple analytes, populate \`result\` with references to the listed Observation IDs. Category should match (e.g., 'laboratory', 'imaging').
- Panel Observation: When the description indicates a panel Observation, populate \`hasMember\` with the listed child Observation IDs.
- Orders (ServiceRequest) vs performed (Procedure): If the target type is \`ServiceRequest\`, generate an order (do NOT include results). If the target type is \`Procedure\`, reflect a performed intervention.
- Imaging: For imaging results, prefer a \`DiagnosticReport\` (category 'imaging'); include \`ImagingStudy\` only when the description provides modality/series details.
- Quantity values: For \`Quantity\` (e.g., Observation.valueQuantity), always use UCUM — set \`system\` to "http://unitsofmeasure.org", \`unit\` to the human-readable unit, and \`code\` to the correct UCUM code. Do not emit placeholder fields for quantities.
 - Subject/Encounter: If the resource supports \`subject\` or \`encounter\`, set them to the provided references so all resources in this document consistently refer to the same patient and encounter.

${
  ips_notes && ips_notes.length ?
    `IPS Guidance (if applicable):
${ips_notes.map((n) => `- ${n}`).join('\n')}
`
  : ''
}

${
  ips_example ?
    `Example (2-space pretty JSON — shape and coding style):
${ips_example}
`
  : ''
}

Coding guidance (important):
- Emit real \`Coding\` entries with \`system\`, \`code\`, and \`display\` for all \`CodeableConcept\`s. Prefer canonical systems based on context (e.g., SNOMED for problems/findings, LOINC for observations/tests, RxNorm for medications, FHIR built-in code systems for enumerations).
- LOINC selection: use standard LOINC test/observable codes for single measurements; do NOT use LOINC Part (\`LP...\`) or LOINC Answer (\`LA...\`) codes unless a specific attribute explicitly requires a Part/Answer.
- CodeableConcept: include exactly ONE Coding in \`coding\` (no synonyms). Choose the single best canonical code; do not add multiple codings to express different nuances.
- If the note does not justify a specific code, pick the most precise code you can justify from the canonical system (we will verify and auto-correct later if needed). Do NOT emit custom placeholder fields.

Return ONLY the generated FHIR resource as a single JSON object.
`,

  // Validation/refinement prompt (restored wording)
  fhir_resource_validate_refine: ({
    resource,
    unresolvedCodings,
    validatorErrors,
    attempts,
    searchNotebook,
    warnings,
    budgetRemaining,
  }: {
    resource: any;
    unresolvedCodings: any[];
    validatorErrors: Array<{ path?: string; severity?: string; message: string }>;
    attempts: Record<string, { queries: string[] }>;
    searchNotebook: Record<
      string,
      Array<{
        query: string;
        systems?: string[];
        meta?: any;
        resultsByQuery?: Array<{
          query: string;
          hits: Array<{ system: string; code: string; display?: string }>;
        }>;
      }>
    >;
    warnings?: Array<{
      pointer: string;
      invalid?: Array<{ system?: string; code?: string }>;
      partials?: Array<{ path: string }>;
      message?: string;
    }>;
    budgetRemaining: number;
  }) => `You are a FHIR resource repair assistant. Your task is to reduce coding/validation issues for a single resource using minimal, safe edits.

Allowed actions (choose exactly one per turn):
- "search_for_coding": request a terminology search for a specific JSON pointer. This does not mutate the resource.
- "update": propose a JSON Patch (RFC6902) with any edits needed to improve correctness and validation.

Guidance:
- Prefer minimal edits that preserve clinical meaning and coherence.
- Changes will be re-validated and accepted only if they improve overall correctness.
 - Address as many clearly resolvable issues as possible in this turn when the correct values are evident from validator errors and the Search Notebook. It is acceptable to include multiple patch operations (and fix multiple pointers) when each change is confidently supported by the available data.

Patch constraints (important):
- When modifying a Coding, update the full Coding entry in one operation. Prefer replacing the entire coding object at the pointer, e.g., {"system":"...","code":"...","display":"..."}.
- Do NOT change a coding's "/code" without also setting "/system" and "/display" for the same coding in the same update.
- You MUST only propose codes that appear in the Search Notebook results for THIS pointer (from the most recent searches shown). Do NOT invent or select codes that are not listed.
 - Whole-subtree edits: When fixing structured datatypes (e.g., Coding, Quantity, Dosage, CodeableConcept), prefer replacing the entire object at that JSON pointer in a single operation rather than emitting many property-level patches. This keeps changes atomic, auditable, and less error‑prone.
 - UCUM units: For Quantity fields, always use UCUM (system = "http://unitsofmeasure.org") and set unit/code accordingly; UCUM units are allowed even if not listed in the Search Notebook.
 - CodeableConcept: ensure \`coding\` contains exactly ONE Coding (pick the single best canonical code; remove synonyms).
 - Scope: Group related fixes in a single patch. You may fix multiple pointers in one patch when each change is independently justified by the Search Notebook and validator feedback; avoid speculative or loosely related edits.
- If no suitable code is present in the Search Notebook for this pointer, prefer:
  1) action "search_for_coding" with new, concise terms and appropriate systems; or
  2) if still no suitable code is found (or budget is low), action "update" that REMOVES the entire coding object at that pointer (e.g., { op: "remove", path: "/.../coding/0" }) rather than emitting a partial/incorrect code.
- Never emit a code-only change without system/display; never choose a code outside the notebook; if neither a valid replacement nor a beneficial structural change is possible, use action "stop".

Coding guidance (LOINC selection):
- When selecting LOINC codes, prefer standard test/observable codes for single measurements.
- Do NOT propose LOINC Part (\`LP...\`) or LOINC Answer (\`LA...\`) codes unless an attribute explicitly requires Part/Answer usage.

${
  warnings && warnings.length ?
    `Previous Attempt Feedback (read carefully):
${warnings
  .map((w) => {
    if (w.invalid && w.invalid.length) {
      const items = w.invalid
        .map((i: any) => {
          const base = `${safeScalar(i.system)}|${safeScalar(i.code)}`;
          return i.canonicalDisplay ? `${base} (canonical display: "${i.canonicalDisplay}")` : base;
        })
        .join(', ');
      const reason = w.message || 'code not present in Search Notebook or policy violation';
      return `- YOU PREVIOUSLY SUBMITTED AN INVALID PATCH. You attempted to insert code(s) ${items} at ${w.pointer || '(unspecified)'}; reason: ${reason}.`;
    }
    if (w.partials && w.partials.length) {
      return `- YOU PREVIOUSLY SUBMITTED AN INVALID PATCH. Partial update at ${w.pointer || '(unspecified)'}: you changed 'code' without also setting 'system' and 'display' in the same replacement.`;
    }
    return w.message ? `- ${w.message}` : '';
  })
  .join('\n')}
`
  : ''
}

Search and modeling guidance (keep forward progress):
- Term picking: start with the core concept (1–3 tokens). If no hits, try synonyms or a simpler hypernym; avoid repeating the same phrase.
- For "search_for_coding", provide terms as an array of distinct, concise phrasings (synonyms/hypernyms). Avoid previously tried queries.
- When a phrase includes quantitative/temporal qualifiers (e.g., “30 pack-year smoking history”), decompose into:
  • a base code for the main concept (e.g., smoking/tobacco use/history), and
  • separate values/attributes for the qualifiers (e.g., the numeric amount, duration, status) using the appropriate fields of this resource.
- If you cannot find a precise code, choose a more general valid code for the primary concept and carry the specifics as values/attributes rather than forcing them into the code text.
- If two consecutive searches for the same pointer yield no usable hits, pivot from search to an update that restructures the data (don’t keep searching the same idea).

Budget = turns remaining. Each "search_for_coding" or "update" consumes 1 turn.
Budget remaining (turns): ${budgetRemaining}

Current Resource (JSON):
${JSON.stringify(resource, null, 2)}

${
  warnings && warnings.length ?
    `Warnings (filtered, not applied in the previous step):\n${warnings
      .map((w) => {
        const removed =
          w.invalid && w.invalid.length ?
            ` — removed: ${w.invalid.map((i) => `${safeScalar(i.system)}|${safeScalar(i.code)}`).join(', ')}`
          : '';
        const partialMsg = w.partials && w.partials.length ? ' — dropped partial property edits' : '';
        const msg = w.message ? ` — ${w.message}` : '';
        return `- pointer: ${w.pointer}${removed}${partialMsg}${msg}`;
      })
      .join('\n')}`
  : ''
}
  
  Validator Errors:
  ${JSON.stringify(validatorErrors, null, 2)}

Prior Attempts (per pointer):
${JSON.stringify(attempts, null, 2)}

Search Notebook (per pointer, prior searches and results by query):
${JSON.stringify(searchNotebook, null, 2)}

Output JSON ONLY, matching one of these shapes:
{ "rationale": "...", "action": "search_for_coding", "pointer": "/path", "terms": ["term1","term2"], "systems": ["http://snomed.info/sct"] }

{ "rationale": "Describe why these changes improve validity/minimize issues.", "action": "update", "patch": [
  // General update (example): fix invalid property or add a required field
  { "op": "remove",  "path": "/description" },
  { "op": "replace", "path": "/status", "value": "active" }
] }

{ "rationale": "Whole-coding replacement per constraints; code appears in Search Notebook.", "action": "update", "patch": [
  // Coding update (example): replace the entire Coding object when changing codes
  { "op": "replace", "path": "/valueCodeableConcept/coding/0", "value": {"system":"...","code":"...","display":"..."}}
] }

{ "rationale": "No suitable code in Search Notebook; removing invalid/placeholder coding.", "action": "update", "patch": [
  // Coding removal (example): when no suitable code can be found in the notebook
  { "op": "remove", "path": "/valueCodeableConcept/coding/0" }
] }

`,
};

export type FhirPromptKey = keyof typeof FHIR_PROMPTS;
